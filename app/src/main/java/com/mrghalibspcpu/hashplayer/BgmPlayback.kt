package com.mrghalibspcpu.hashplayer

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * Background music (BGM) — a second, fully independent ExoPlayer that loops a
 * quiet track *underneath* whatever the main player is doing.
 *
 * Why a native player and not the WebView's <audio> tag:
 *
 *  • a device file in the library is a `content://` uri; Chromium's <audio>
 *    cannot open those, so the old BGM simply stayed silent in the app;
 *  • WebView media requests Android audio focus for itself, which made the
 *    main ExoPlayer *lose* focus and pause the moment the BGM started — the
 *    exact opposite of "play behind my media";
 *  • YouTube as BGM needs the audio-only stream, which only the native
 *    resolver can fetch.
 *
 * It never asks for audio focus (the main player owns it), never touches the
 * EQ/visualiser session and is driven only through four verbs from the web
 * layer: load / play / pause / stop, plus a volume. The web layer is the single
 * source of truth for *when* it plays: it mirrors the main transport, so the
 * BGM pauses with the main media and resumes with it.
 */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class BgmPlayback(
    private val ctx: Context,
    private val emit: (String) -> Unit
) {
    companion object { private const val TAG = "HashPlayerBGM" }

    private val main = Handler(Looper.getMainLooper())
    private var player: ExoPlayer? = null
    private var currentUri = ""
    private var volume = 0.1f
    private var wantPlay = false
    private var retried = false
    /** Bumped on every load so a slow YouTube lookup cannot resurrect an old BGM. */
    private var generation = 0

    private fun engine(): ExoPlayer {
        player?.let { return it }
        val p = ExoPlayer.Builder(
            ctx,
            DefaultRenderersFactory(ctx)
                .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER)
                .setEnableDecoderFallback(true)
        ).build()
        p.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build(),
            /* handleAudioFocus = */ false          // the main player owns focus; never fight it
        )
        p.setWakeMode(C.WAKE_MODE_LOCAL)
        p.repeatMode = Player.REPEAT_MODE_ONE          // loop forever behind the media
        p.volume = volume
        p.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                when (state) {
                    Player.STATE_READY -> { retried = false; post("ready") }
                    Player.STATE_BUFFERING -> post("waiting")
                    Player.STATE_ENDED -> {
                        // REPEAT_MODE_ONE normally never ends; a live/odd stream can.
                        try { p.seekTo(0); if (wantPlay) p.play() } catch (e: Exception) { }
                    }
                }
            }
            override fun onIsPlayingChanged(playing: Boolean) { post(if (playing) "play" else "pause") }
            override fun onPlayerError(error: PlaybackException) {
                Log.w(TAG, "bgm error", error)
                if (currentUri.startsWith(NativePlayback.YT_SCHEME))
                    YouTubeStream.forget(currentUri.removePrefix(NativePlayback.YT_SCHEME))
                if (!retried) {
                    retried = true
                    main.postDelayed({ try { player?.prepare() } catch (e: Exception) { } }, 300)
                    return
                }
                post("error", error.errorCodeName)
            }
        })
        player = p
        return p
    }

    /** @param uri `content://`, `file://`, http(s) or `hpyt:<id>` */
    fun load(uri: String, vol: Float, autoplay: Boolean) = main.post {
        try {
            val p = engine()
            volume = vol.coerceIn(0f, 1f)
            p.volume = volume
            currentUri = uri
            wantPlay = autoplay
            retried = false
            val mine = ++generation
            if (uri.startsWith(NativePlayback.YT_SCHEME)) {
                loadYouTube(uri.removePrefix(NativePlayback.YT_SCHEME), mine, autoplay)
                return@post
            }
            val item = MediaItem.fromUri(Uri.parse(uri))
            val headers = NativePlayback.headersFor(uri)
            if (headers != null) p.setMediaSource(webSource(item, uri, headers))
            else p.setMediaItem(item)
            p.prepare()
            p.playWhenReady = autoplay
            post("loaded")
        } catch (e: Exception) {
            Log.w(TAG, "bgm load failed", e)
            post("error", "OPEN_FAILED")
        }
    }

    private fun webSource(item: MediaItem, uri: String, headers: Map<String, String>): MediaSource {
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent(headers["User-Agent"] ?: "Mozilla/5.0")
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(20_000)
            .setDefaultRequestProperties(headers.filterKeys { it != "User-Agent" })
        val path = Uri.parse(uri).path.orEmpty().lowercase()
        return if (path.endsWith(".m3u8")) HlsMediaSource.Factory(http).createMediaSource(item)
        else ProgressiveMediaSource.Factory(http).createMediaSource(item)
    }

    /** YouTube as BGM: only the audio stream is fetched — no video is ever decoded. */
    private fun loadYouTube(videoId: String, mine: Int, autoplay: Boolean) {
        post("waiting")
        thread(name = "hp-bgm-yt") {
            val r = try { YouTubeStream.resolve(videoId, 360) } catch (e: Throwable) {
                Log.w(TAG, "bgm youtube resolve crashed", e); null
            }
            main.post {
                if (mine != generation) return@post
                if (r == null || !r.playable) { post("error", "YT_UNRESOLVED"); return@post }
                try {
                    val p = engine()
                    val http = DefaultHttpDataSource.Factory()
                        .setUserAgent(r.userAgent)
                        .setAllowCrossProtocolRedirects(true)
                        .setConnectTimeoutMs(15_000)
                        .setReadTimeoutMs(20_000)
                        .setKeepPostFor302Redirects(true)
                        .setDefaultRequestProperties(
                            mapOf("Origin" to "https://www.youtube.com", "Referer" to "https://www.youtube.com/")
                        )
                    val s = r.audio ?: r.muxed ?: r.video
                    val src: MediaSource = when {
                        s != null -> ProgressiveMediaSource.Factory(bounded(http, s.contentLength))
                            .createMediaSource(MediaItem.fromUri(s.url))
                        r.hls != null -> HlsMediaSource.Factory(http).createMediaSource(MediaItem.fromUri(r.hls!!))
                        else -> { post("error", "YT_UNRESOLVED"); return@post }
                    }
                    p.setMediaSource(src)
                    // Audio only: drop any video/text tracks so the decoder stays idle.
                    p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
                        .setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, true)
                        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                        .build()
                    p.prepare()
                    p.playWhenReady = autoplay && wantPlay
                    post("loaded")
                } catch (e: Throwable) {
                    Log.w(TAG, "bgm youtube load failed", e)
                    YouTubeStream.forget(videoId)
                    post("error", "YT_UNRESOLVED")
                }
            }
        }
    }

    private fun bounded(base: DataSource.Factory, length: Long): DataSource.Factory {
        if (length <= 0) return base
        return ResolvingDataSource.Factory(base) { spec ->
            if (spec.length == C.LENGTH_UNSET.toLong() && spec.position in 0 until length)
                spec.subrange(0, length - spec.position)
            else spec
        }
    }

    fun play() = main.post {
        wantPlay = true
        val p = player ?: return@post
        if (currentUri.isEmpty()) return@post
        if (p.playbackState == Player.STATE_IDLE || p.playbackState == Player.STATE_ENDED) p.prepare()
        p.playWhenReady = true
    }

    fun pause() = main.post {
        wantPlay = false
        player?.playWhenReady = false
    }

    fun setVolume(v: Float) = main.post {
        volume = v.coerceIn(0f, 1f)
        try { player?.volume = volume } catch (e: Exception) { }
    }

    fun stop() = main.post {
        wantPlay = false
        generation++
        currentUri = ""
        try { player?.stop(); player?.clearMediaItems() } catch (e: Exception) { }
    }

    fun release() = main.post {
        wantPlay = false
        generation++
        currentUri = ""
        try { player?.release() } catch (e: Exception) { }
        player = null
    }

    fun isPlayingNow(): Boolean = player?.isPlaying == true

    private fun post(event: String, detail: String = "") {
        val o = JSONObject()
        try {
            o.put("e", "bgm")
            o.put("state", event)
            o.put("detail", detail)
            o.put("uri", currentUri)
            o.put("playing", player?.isPlaying == true)
        } catch (e: Exception) { return }
        emit(o.toString())
    }
}
