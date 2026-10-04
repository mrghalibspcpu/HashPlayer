package com.mrghalibspcpu.hashplayer

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.Matrix
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.media.audiofx.BassBoost
import android.media.audiofx.Equalizer
import android.media.audiofx.Visualizer
import android.view.Gravity
import android.view.TextureView
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.media3.common.AudioAttributes
import androidx.media3.common.text.CueGroup
import androidx.media3.common.MimeTypes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

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
    private var surface: TextureView? = null
    private var eq: Equalizer? = null
    private var bass: BassBoost? = null
    private var vis: Visualizer? = null
    private var visWanted = false
    private var lastWave: JSONArray? = null
    private var eqOn = false
    private var eqGains = FloatArray(10)

    /** What the web app calls this track — echoed back so it can match events. */
    private var reportUri: String = ""
    private var currentUri: String = ""
    private var isVideo = false
    private var retried = false
    private var ticking = false
    private var lastEmit = 0L

    /* The TextureView always occupies the web stage. ExoPlayer renders into a
       TextureView by stretching its buffer to that view, so we counter-scale
       the texture below to preserve the video's display aspect ratio. */
    private var resizeMode = "contain"
    private var stageWidth = 1
    private var stageHeight = 1

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
                    Player.STATE_READY -> {
                        retried = false
                        applyEq()
                        if (visWanted) attachVisualiser()
                        post("ready")
                    }
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
                applyVideoTransform()
                post("resize")
            }

            override fun onCues(cueGroup: CueGroup) {
                val txt = cueGroup.cues.mapNotNull { it.text?.toString() }
                    .filter { it.isNotBlank() }.joinToString("\n")
                emitCues(txt)
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

    /**
     * The video is drawn by a TextureView *behind* the (transparent) WebView.
     *
     * A SurfaceView would be cheaper, but it lives in its own window below the
     * app window — the opaque root view then covers it and you get sound with a
     * black screen. A TextureView is composited inside the normal view tree, so
     * the web UI can sit on top of it.
     */
    private fun ensureSurface(): TextureView {
        surface?.let { return it }
        val sv = TextureView(activity).apply {
            isOpaque = true
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
        stageWidth = maxOf(1, (w * d).toInt())
        stageHeight = maxOf(1, (h * d).toInt())
        lp.width = stageWidth
        lp.height = stageHeight
        lp.leftMargin = (x * d).toInt()
        lp.topMargin = (y * d).toInt()
        sv.layoutParams = lp
        applyVideoTransform()
    }

    /**
     * TextureView stretches its decoded buffer to its own bounds. Apply the
     * inverse scale around the centre so `contain` (the default) letterboxes
     * instead of distorting. `cover` crops and `fill` is the explicit stretch
     * option exposed by the web controls.
     */
    private fun applyVideoTransform() {
        val sv = surface ?: return
        val size = player?.videoSize ?: return
        if (stageWidth <= 0 || stageHeight <= 0 || size.width <= 0 || size.height <= 0) {
            sv.setTransform(Matrix())
            return
        }

        var videoAspect = size.width.toFloat() * size.pixelWidthHeightRatio / size.height.toFloat()
        if (size.unappliedRotationDegrees == 90 || size.unappliedRotationDegrees == 270) {
            videoAspect = 1f / videoAspect
        }
        if (!videoAspect.isFinite() || videoAspect <= 0f) videoAspect = 16f / 9f
        val viewAspect = stageWidth.toFloat() / stageHeight.toFloat()
        var sx = 1f
        var sy = 1f

        when (resizeMode) {
            "fill" -> Unit
            "cover" -> {
                if (videoAspect > viewAspect) sx = videoAspect / viewAspect
                else sy = viewAspect / videoAspect
            }
            else -> { // contain / aspect-fit
                if (videoAspect > viewAspect) sy = viewAspect / videoAspect
                else sx = videoAspect / viewAspect
            }
        }

        val matrix = Matrix().apply {
            setScale(sx, sy, stageWidth / 2f, stageHeight / 2f)
        }
        sv.setTransform(matrix)
    }

    fun setResizeMode(mode: String) = main.post {
        resizeMode = when (mode) {
            "cover", "fill" -> mode
            else -> "contain"
        }
        applyVideoTransform()
    }

    private fun showSurface(show: Boolean) = main.post {
        if (show) {
            val sv = ensureSurface()
            sv.visibility = android.view.View.VISIBLE
            player?.setVideoTextureView(sv)
            applyVideoTransform()
        } else {
            player?.clearVideoSurface()
            surface?.visibility = android.view.View.GONE
        }
    }

    /** Hide only the picture when leaving the player route; media stays loaded. */
    fun setVideoVisible(visible: Boolean) = showSurface(visible && isVideo)

    /* ------------------------------------------------------------ commands */

    fun load(uri: String, reportAs: String, startSec: Double, autoplay: Boolean, video: Boolean, subtitle: String) = main.post {
        try {
            val p = engine()
            currentUri = uri
            reportUri = if (reportAs.isNotEmpty()) reportAs else uri
            isVideo = video
            resizeMode = "contain"                 // every video starts aspect-correct
            retried = false

            val b = MediaItem.Builder().setUri(Uri.parse(uri))
            subtitleItem(subtitle)?.let { b.setSubtitleConfigurations(listOf(it)) }
            p.setMediaItem(b.build())
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
        try { vis?.enabled = false; vis?.release() } catch (e: Throwable) { }
        try { eq?.release(); bass?.release() } catch (e: Throwable) { }
        vis = null; eq = null; bass = null
        player?.release()
        player = null
        surface?.let { root.removeView(it) }
        surface = null
    }

    fun isPlayingNow(): Boolean = player?.isPlaying == true

    /** For the media notification / lock-screen scrubber. -1 when idle. */
    fun positionMs(): Long = player?.let { if (currentUri.isEmpty()) -1L else it.currentPosition } ?: -1L
    fun durationMs(): Long = player?.let {
        val d = it.duration
        if (currentUri.isEmpty() || d == C.TIME_UNSET || d < 0) -1L else d
    } ?: -1L

    fun hasVideoNow(): Boolean = isVideo && (player?.videoSize?.width ?: 0) > 0

    fun videoWidth(): Int = player?.videoSize?.width ?: 0
    fun videoHeight(): Int = player?.videoSize?.height ?: 0

    /* ------------------------------------------------------------ subtitles */

    /**
     * External .srt/.vtt the web app already parsed: ExoPlayer wants a Uri, so the
     * text is dropped into the cache directory and handed over as a side-loaded
     * subtitle track. Embedded tracks (mkv) need nothing — they just arrive.
     */
    private fun subtitleItem(text: String): MediaItem.SubtitleConfiguration? {
        if (text.isBlank()) return null
        return try {
            val f = File(activity.cacheDir, "subtitle.vtt")
            f.writeText(if (text.trimStart().startsWith("WEBVTT")) text else "WEBVTT\n\n" + text)
            MediaItem.SubtitleConfiguration.Builder(Uri.fromFile(f))
                .setMimeType(MimeTypes.TEXT_VTT)
                .setLanguage("en")
                .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                .build()
        } catch (e: Exception) { null }
    }

    fun setSubtitlesEnabled(on: Boolean) = main.post {
        try {
            val p = player ?: return@post
            p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, !on).build()
            if (!on) emitCues("")
        } catch (e: Exception) { }
    }

    private fun emitCues(text: String) {
        val o = JSONObject()
        try { o.put("e", "cues"); o.put("detail", text); o.put("uri", reportUri) } catch (e: Exception) { return }
        emit(o.toString())
    }

    /* ------------------------------------------------------------ equaliser */

    /** 10 web sliders (31 Hz … 16 kHz) mapped onto the device's own EQ bands. */
    fun setEq(on: Boolean, gains: FloatArray) = main.post {
        eqOn = on
        if (gains.size == 10) eqGains = gains
        applyEq()
    }

    private val webFreqs = intArrayOf(31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000)

    private fun applyEq() {
        val p = player ?: return
        try {
            if (eq == null) {
                eq = Equalizer(0, p.audioSessionId)
                bass = try { BassBoost(0, p.audioSessionId) } catch (e: Throwable) { null }
            }
            val e = eq ?: return
            e.enabled = eqOn
            bass?.enabled = eqOn && eqGains[0] > 0.5f
            if (!eqOn) return
            val range = e.bandLevelRange              // millibel
            val lo = range[0].toInt(); val hi = range[1].toInt()
            for (band in 0 until e.numberOfBands) {
                val centerHz = e.getCenterFreq(band.toShort()) / 1000
                // nearest web slider for this hardware band
                var best = 0
                for (i in webFreqs.indices)
                    if (Math.abs(webFreqs[i] - centerHz) < Math.abs(webFreqs[best] - centerHz)) best = i
                val mb = (eqGains[best] * 100).toInt().coerceIn(lo, hi)
                try { e.setBandLevel(band.toShort(), mb.toShort()) } catch (ex: Exception) { }
            }
            bass?.let { bb ->
                if (bb.strengthSupported) {
                    val amount = ((eqGains[0] + eqGains[1]) / 2f).coerceIn(0f, 12f) / 12f
                    try { bb.setStrength((amount * 900).toInt().toShort()) } catch (ex: Exception) { }
                }
            }
        } catch (e: Throwable) { Log.w(TAG, "equaliser unavailable", e) }
    }

    /* ------------------------------------------------------------ visualiser */

    /** Needs RECORD_AUDIO (Android's rule for tapping an audio session). */
    fun setVisualiser(on: Boolean) = main.post {
        visWanted = on
        if (on) {
            attachVisualiser()
        } else {
            try { vis?.enabled = false; vis?.release() } catch (e: Throwable) { }
            vis = null
        }
    }

    private fun attachVisualiser() {
        val p = player ?: return
        if (vis != null) return
        try {
            val v = Visualizer(p.audioSessionId)
            v.captureSize = Visualizer.getCaptureSizeRange()[1].coerceAtMost(256)
            v.setDataCaptureListener(object : Visualizer.OnDataCaptureListener {
                override fun onWaveFormDataCapture(vz: Visualizer?, wave: ByteArray?, rate: Int) {
                    val wv = wave ?: return
                    val out = JSONArray()
                    val step = maxOf(1, wv.size / 128)
                    var i = 0
                    while (i < wv.size && out.length() < 128) {
                        out.put(wv[i].toInt() and 0xFF)      // already 0..255, like getByteTimeDomainData
                        i += step
                    }
                    lastWave = out
                }
                override fun onFftDataCapture(vz: Visualizer?, fft: ByteArray?, rate: Int) {
                    val f = fft ?: return
                    val bins = 64
                    val arr = JSONArray()
                    var i = 0
                    while (i < bins) {
                        val re = if (i * 2 < f.size) f[i * 2].toInt() else 0
                        val im = if (i * 2 + 1 < f.size) f[i * 2 + 1].toInt() else 0
                        val mag = Math.hypot(re.toDouble(), im.toDouble())
                        arr.put(Math.min(255.0, mag * 3).toInt())
                        i++
                    }
                    val o = JSONObject()
                    try {
                        o.put("e", "fft"); o.put("fft", arr); o.put("uri", reportUri)
                        lastWave?.let { o.put("wave", it) }
                    } catch (e: Exception) { return }
                    emit(o.toString())
                }
            }, (Visualizer.getMaxCaptureRate() / 2).coerceAtMost(20000), true, true)
            v.enabled = true
            vis = v
        } catch (e: Throwable) {
            Log.w(TAG, "visualiser unavailable", e)
        }
    }

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
            o.put("uri", reportUri)
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
