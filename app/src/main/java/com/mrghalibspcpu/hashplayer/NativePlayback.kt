package com.mrghalibspcpu.hashplayer

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.SurfaceView
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import org.json.JSONObject

/**
 * The real playback engine.
 *
 * Everything that lives on the device (MediaStore scan results, "open with"
 * files) is decoded by ExoPlayer instead of the WebView's <video> tag:
 *
 *  • formats — mkv / avi / flac / opus / ac3 / hevc all play, the WebView
 *    could only ever decode the handful of codecs Chromium ships, which is why
 *    videos refused to start and odd files died with "can't be decoded";
 *  • stability — no blob URLs, no range-streaming through
 *    shouldInterceptRequest, so a song can no longer stop after a few seconds;
 *  • background — audio focus, becoming-noisy and a wake lock are handled
 *    natively, so playback keeps going with the screen off.
 *
 * The web app keeps owning the whole UI: it drives this class through the
 * JS bridge and receives state back as `HashBridge.onNative({...})`.
 */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class NativePlayback(
    private val activity: Activity,
    private val root: FrameLayout,
    private val emit: (String) -> Unit
) {

    companion object { private const val TAG = "HashPlayerNative" }

    private val main = Handler(Looper.getMainLooper())
    private var player: ExoPlayer? = null
    private var surface: SurfaceView? = null

    private var currentUri: String = ""
    private var isVideo = false
    private var retried = false
    private var ticking = false
    private var lastEmit = 0L

    private val tick = object : Runnable {
        override fun run() {
            val p = player ?: return
            post(if (p.isPlaying) "timeupdate" else "tick")
            if (ticking) main.postDelayed(this, 250)
        }
    }

    /* ------------------------------------------------------------ engine */

    private fun engine(): ExoPlayer {
        player?.let { return it }
        val p = ExoPlayer.Builder(
            activity,
            DefaultRenderersFactory(activity)
                .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER)
                .setEnableDecoderFallback(true)        // a flaky hardware decoder falls back to software
        )
            .setHandleAudioBecomingNoisy(true)         // unplugging headphones pauses, never blasts
            .setSeekBackIncrementMs(10_000)
            .setSeekForwardIncrementMs(10_000)
            .build()

        p.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build(),
            /* handleAudioFocus = */ true
        )
        p.setWakeMode(C.WAKE_MODE_LOCAL)               // keeps decoding with the screen off

        p.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                when (state) {
                    Player.STATE_READY -> { retried = false; post("ready") }
                    Player.STATE_BUFFERING -> post("waiting")
                    Player.STATE_ENDED -> { stopTick(); post("ended") }
                    Player.STATE_IDLE -> post("idle")
                }
            }

            override fun onIsPlayingChanged(playing: Boolean) {
                if (playing) startTick() else stopTick()
                post(if (playing) "play" else "pause")
            }

            override fun onVideoSizeChanged(size: VideoSize) {
                post("resize")
            }

            override fun onPlayerError(error: PlaybackException) {
                Log.w(TAG, "playback error", error)
                // One silent re-prepare fixes the transient decoder/IO hiccups that
                // used to surface as a scary "file unavailable" toast.
                if (!retried) {
                    retried = true
                    main.postDelayed({ try { player?.prepare() } catch (e: Exception) { } }, 250)
                    return
                }
                post("error", error.errorCodeName)
            }
        })
        player = p
        return p
    }

    private fun startTick() {
        if (ticking) return
        ticking = true
        main.post(tick)
    }

    private fun stopTick() { ticking = false; main.removeCallbacks(tick) }

    /* ------------------------------------------------------------ surface */

    /** The video is drawn by a SurfaceView *behind* the (transparent) WebView. */
    private fun ensureSurface(): SurfaceView {
        surface?.let { return it }
        val sv = SurfaceView(activity).apply {
            setBackgroundColor(Color.BLACK)
            layoutParams = FrameLayout.LayoutParams(1, 1, Gravity.TOP or Gravity.START)
        }
        root.addView(sv, 0)                       // index 0 → underneath the WebView
        surface = sv
        return sv
    }

    /** Place the video exactly where the web UI's stage is, in CSS pixels. */
    fun setRect(x: Float, y: Float, w: Float, h: Float) = main.post {
        val sv = surface ?: return@post
        val d = activity.resources.displayMetrics.density
        val lp = sv.layoutParams as FrameLayout.LayoutParams
        lp.width = maxOf(1, (w * d).toInt())
        lp.height = maxOf(1, (h * d).toInt())
        lp.leftMargin = (x * d).toInt()
        lp.topMargin = (y * d).toInt()
        sv.layoutParams = lp
    }

    private fun showSurface(show: Boolean) = main.post {
        if (show) {
            val sv = ensureSurface()
            sv.visibility = android.view.View.VISIBLE
            player?.setVideoSurfaceView(sv)
        } else {
            player?.clearVideoSurface()
            surface?.visibility = android.view.View.GONE
        }
    }

    /* ------------------------------------------------------------ commands */

    fun load(uri: String, startSec: Double, autoplay: Boolean, video: Boolean) = main.post {
        try {
            val p = engine()
            currentUri = uri
            isVideo = video
            retried = false
            p.setMediaItem(MediaItem.fromUri(Uri.parse(uri)))
            p.prepare()
            if (startSec > 0) p.seekTo((startSec * 1000).toLong())
            showSurface(video)
            p.playWhenReady = autoplay
            post("loaded")
            startTick()
        } catch (e: Exception) {
            Log.w(TAG, "load failed", e)
            post("error", "OPEN_FAILED")
        }
    }

    fun play() = main.post {
        val p = player ?: return@post
        if (p.playbackState == Player.STATE_IDLE || p.playbackState == Player.STATE_ENDED) p.prepare()
        p.play()
    }

    fun pause() = main.post { player?.pause() }

    fun seek(sec: Double) = main.post {
        player?.seekTo((sec * 1000).toLong())
        post("seeked")
    }

    fun rate(r: Float) = main.post { try { player?.setPlaybackSpeed(r.coerceIn(0.25f, 4f)) } catch (e: Exception) { } }

    fun volume(v: Float) = main.post { player?.volume = v.coerceIn(0f, 1f) }

    fun stop() = main.post {
        stopTick()
        player?.stop()
        player?.clearMediaItems()
        currentUri = ""
        showSurface(false)
    }

    fun release() = main.post {
        stopTick()
        player?.release()
        player = null
        surface?.let { root.removeView(it) }
        surface = null
    }

    fun isPlayingNow(): Boolean = player?.isPlaying == true

    fun hasVideoNow(): Boolean = isVideo && (player?.videoSize?.width ?: 0) > 0

    fun videoWidth(): Int = player?.videoSize?.width ?: 0
    fun videoHeight(): Int = player?.videoSize?.height ?: 0

    /* ------------------------------------------------------------ state out */

    private fun post(event: String, detail: String = "") {
        val p = player ?: return
        val now = System.currentTimeMillis()
        if (event == "timeupdate" && now - lastEmit < 200) return
        lastEmit = now
        val o = JSONObject()
        try {
            o.put("e", event)
            o.put("detail", detail)
            o.put("uri", currentUri)
            o.put("pos", p.currentPosition / 1000.0)
            val d = p.duration
            o.put("dur", if (d == C.TIME_UNSET || d < 0) 0.0 else d / 1000.0)
            o.put("buffered", p.bufferedPosition / 1000.0)
            o.put("paused", !p.isPlaying)
            o.put("state", p.playbackState)
            o.put("vw", p.videoSize.width)
            o.put("vh", p.videoSize.height)
        } catch (e: Exception) { return }
        emit(o.toString())
    }
}
