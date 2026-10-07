package com.mrghalibspcpu.hashplayer

import android.annotation.SuppressLint
import android.app.PictureInPictureParams
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.database.ContentObserver
import android.graphics.Bitmap
import android.graphics.Color
import android.media.AudioManager
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.Settings
import android.util.Log
import android.util.Rational
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebViewClient
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import android.view.Gravity
import android.webkit.CookieManager
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import android.util.Base64
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.FilterInputStream
import java.io.InputStream
import kotlin.concurrent.thread

/**
 * HashPlayer — native shell.
 *
 * The whole player is the web app in /web, served to the WebView from the APK
 * assets over https://appassets.androidplatform.net so that service workers,
 * IndexedDB and the Web Audio API all behave exactly like they do in a browser.
 *
 * The native side adds what a browser cannot do on Android:
 *   • MediaStore scan of every song / video on the device (automatic on launch)
 *   • seekable Range streaming of those content:// files into the <video> tag
 *   • "Open with" / "Share to" from file managers, galleries and YouTube
 *   • real picture-in-picture, immersive fullscreen and orientation locking
 *   • a media-session notification + foreground service for background playback
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "HashPlayer"
        const val ORIGIN = "https://appassets.androidplatform.net"
        const val START_URL = "$ORIGIN/assets/www/index.html"
        private const val MEDIA_PREFIX = "/media/"
        private const val PREFS = "hashplayer"
        private const val KEY_ASKED = "asked_media_permission"
        private val LINK = Regex("""https?://\S+""")
    }

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var loader: WebViewAssetLoader
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var pageReady = false
    private val pending = ArrayList<String>()
    private var isPlaying = false
    private var hasVideo = false
    private var videoRatio = Rational(16, 9)
    private var autoPip = true
    private var lastBackPress = 0L
    private var didAutoScan = false
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null
    private lateinit var nativePlayer: NativePlayback

    /* The in-app YouTube browser: the real youtube.com in its own WebView on
       top of the player, used purely for browsing and searching. */
    private var ytLayer: View? = null
    private var ytWeb: WebView? = null
    private var ytPicked = ""

    /* The volume slider and the vertical swipe move the *device* media volume,
       the same thing the hardware keys do — so the UI has to follow the keys too. */
    private val audio: AudioManager by lazy {
        getSystemService(Context.AUDIO_SERVICE) as AudioManager
    }
    private var lastVolumeSent = -1f
    private var volumeObserver: ContentObserver? = null

    private val fileChooser =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
            val cb = filePathCallback
            filePathCallback = null
            cb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res.resultCode, res.data))
        }

    /* Guards the unified startup permission flow: the native onPageFinished auto-scan
       and the web app's own "scanMedia" fallback (used on in-page reloads) can both
       fire within a few hundred milliseconds of a fresh install. Without this guard
       the second call re-launches the system permission flow while the first is
       still pending, which truncates it to a single permission instead of the full,
       batched set — leaving audio or video unreadable until the app is restarted. */
    private var permissionRequestInFlight = false
    private var pendingScanSilent = true

    private val permissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            permissionRequestInFlight = false
            if (grants.values.any { it }) scanDevice(pendingScanSilent)
            else toast(getString(R.string.need_permission))
        }

    private val notifPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    /** Only ever used to read our own audio session for the visualiser. */
    private val micPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            nativePlayer.setVisualiser(granted)
            if (!granted) toast(getString(R.string.vis_needs_mic))
        }

    /* ====================================================== lifecycle */

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        loader = WebViewAssetLoader.Builder()
            .setDomain("appassets.androidplatform.net")
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(Color.parseColor("#07080C"))
            overScrollMode = WebView.OVER_SCROLL_NEVER
            isVerticalScrollBarEnabled = false
        }
        root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(web)
        }
        setContentView(root)

        nativePlayer = NativePlayback(this, root) { json ->
            runOnUiThread {
                web.evaluateJavascript(
                    "window.HashBridge && window.HashBridge.onNative(" + JSONObject.quote(json) + ");", null
                )
            }
        }

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            allowFileAccess = false
            allowContentAccess = true
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            textZoom = 100
            userAgentString = "$userAgentString HashPlayer/2.7.0"
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView, request: WebResourceRequest
            ): WebResourceResponse? {
                val url = request.url
                if (url.host == "appassets.androidplatform.net" &&
                    url.path?.startsWith(MEDIA_PREFIX) == true
                ) return mediaResponse(request)
                return loader.shouldInterceptRequest(url)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // iframes (the YouTube player) must be allowed to navigate inside the WebView —
                // only a *top level* jump to another site is handed to the browser.
                if (!request.isForMainFrame) return false
                return external(request.url)
            }

            @Deprecated("kept for API 23", ReplaceWith(""))
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
                external(Uri.parse(url))

            private fun external(u: Uri): Boolean {
                if (u.host == "appassets.androidplatform.net") return false
                if (u.host?.contains("youtube.com") == true || u.host == "youtu.be") return false
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, u)); true
                } catch (e: Exception) { true }
            }

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                pending.forEach { view.evaluateJavascript(it, null) }
                pending.clear()
                if (!didAutoScan) { didAutoScan = true; view.postDelayed({ autoScan() }, 700) }
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?, callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                val pick = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(
                        Intent.EXTRA_MIME_TYPES,
                        arrayOf("audio/*", "video/*", "text/plain", "application/x-subrip")
                    )
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
                return try {
                    fileChooser.launch(Intent.createChooser(pick, "Select media"))
                    true
                } catch (e: Exception) {
                    filePathCallback = null
                    toast("No file picker found on this device")
                    false
                }
            }

            /* HTML5 fullscreen — without this, "fullscreen video" silently does nothing. */
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (customView != null) { callback.onCustomViewHidden(); return }
                customView = view
                customCallback = callback
                root.addView(
                    view,
                    FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
                    )
                )
                web.visibility = View.GONE
                immersive(true)
            }

            override fun onHideCustomView() {
                customView?.let { root.removeView(it) }
                customView = null
                web.visibility = View.VISIBLE
                customCallback?.onCustomViewHidden()
                customCallback = null
                immersive(false)
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                // Only DRM playback is ever granted; camera/mic are always refused.
                val drm = request.resources.filter { it == PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID }
                if (drm.isNotEmpty()) request.grant(drm.toTypedArray()) else request.deny()
            }

            override fun onConsoleMessage(cm: ConsoleMessage): Boolean {
                if (cm.messageLevel() == ConsoleMessage.MessageLevel.ERROR)
                    Log.w(TAG, "JS: ${cm.message()} @${cm.lineNumber()}")
                return true
            }
        }

        web.addJavascriptInterface(Bridge(), "HashNative")
        PlaybackService.transport = { action ->
            runOnUiThread {
                web.evaluateJavascript(
                    "window.HashBridge && window.HashBridge.onTransport(" + JSONObject.quote(action) + ");", null
                )
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (customView != null) { web.webChromeClient?.onHideCustomView(); return }
                if (ytLayer != null) {
                    val wv = ytWeb
                    if (wv != null && wv.canGoBack()) wv.goBack() else closeYouTubeBrowser()
                    return
                }
                web.evaluateJavascript("window.HashBridge ? window.HashBridge.onBack() : false") { r ->
                    if (r != "true") {
                        val now = System.currentTimeMillis()
                        if (now - lastBackPress < 2200) {
                            PlaybackService.stop(this@MainActivity)
                            finish()
                        } else {
                            lastBackPress = now
                            toast(getString(R.string.press_back))
                        }
                    }
                }
            }
        })

        /* Hardware volume keys should always mean "media volume" here, even while
           nothing is playing yet — otherwise they change the ringer instead. */
        volumeControlStream = AudioManager.STREAM_MUSIC
        watchVolume()

        if (savedInstanceState == null) web.loadUrl(START_URL) else web.restoreState(savedInstanceState)
        handleIntent(intent)
    }

    /* ====================================================== device volume */

    private fun maxVolume(): Int = try {
        audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
    } catch (e: Exception) { 15 }

    private fun deviceVolume(): Float = try {
        audio.getStreamVolume(AudioManager.STREAM_MUSIC).toFloat() / maxVolume()
    } catch (e: Exception) { 1f }

    /** Mirror hardware-key / system changes into the player UI. */
    private fun watchVolume() {
        val obs = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                val v = deviceVolume()
                if (kotlin.math.abs(v - lastVolumeSent) < 0.001f) return
                lastVolumeSent = v
                js("window.HashBridge && window.HashBridge.onVolume($v);")
            }
        }
        volumeObserver = obs
        try {
            contentResolver.registerContentObserver(Settings.System.CONTENT_URI, true, obs)
        } catch (e: Exception) { Log.w(TAG, "volume observer", e) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        if (!isPlaying) { web.onPause(); web.pauseTimers() }   // keep audio alive in the background
    }

    override fun onResume() {
        super.onResume()
        web.resumeTimers(); web.onResume()
    }

    /** Home / recents while a video is playing → slide into picture-in-picture. */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (autoPip && isPlaying && hasVideo && customView == null) enterPip()
    }

    @SuppressLint("NewApi")
    override fun onPictureInPictureModeChanged(inPip: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(inPip, newConfig)
        js("window.HashBridge && window.HashBridge.onPip($inPip);")
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // Keep ExoPlayer alive across rotation, then re-bind its texture after
        // the new root bounds have been laid out by the window manager.
        nativePlayer.onConfigurationChanged()
        val land = newConfig.orientation == Configuration.ORIENTATION_LANDSCAPE
        js("window.HashBridge && window.HashBridge.onRotate($land);")
    }

    override fun onDestroy() {
        PlaybackService.transport = null
        PlaybackService.stop(this)
        volumeObserver?.let { try { contentResolver.unregisterContentObserver(it) } catch (e: Exception) { } }
        volumeObserver = null
        nativePlayer.release()
        web.destroy()
        super.onDestroy()
    }

    /* ====================================================== JS bridge */

    inner class Bridge {
        @android.webkit.JavascriptInterface
        fun scanMedia() = runOnUiThread { ensureMediaAccess(false) }

        @android.webkit.JavascriptInterface
        fun setPlaybackState(playing: Boolean, title: String?, artist: String?) = runOnUiThread {
            isPlaying = playing
            if (playing && Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this@MainActivity, "android.permission.POST_NOTIFICATIONS")
                != PackageManager.PERMISSION_GRANTED
            ) notifPermission.launch("android.permission.POST_NOTIFICATIONS")
            PlaybackService.update(
                this@MainActivity, playing, title ?: "", artist ?: "",
                nativePlayer.positionMs(), nativePlayer.durationMs()
            )
        }

        /** The web player tells us whether the current track is a video, and its shape. */
        @android.webkit.JavascriptInterface
        fun setVideoState(video: Boolean, w: Int, h: Int) = runOnUiThread {
            hasVideo = video
            if (w > 0 && h > 0) videoRatio = safeRatio(w, h)
        }

        @android.webkit.JavascriptInterface
        fun enterPip() { runOnUiThread { this@MainActivity.enterPip() } }

        @android.webkit.JavascriptInterface
        fun setAutoPip(on: Boolean) { autoPip = on }

        @android.webkit.JavascriptInterface
        fun pipSupported(): Boolean =
            Build.VERSION.SDK_INT >= 26 &&
                packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

        /** "auto" | "landscape" | "portrait" */
        @android.webkit.JavascriptInterface
        fun setOrientation(mode: String) = runOnUiThread {
            requestedOrientation = when (mode) {
                "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
        }

        @android.webkit.JavascriptInterface
        fun setFullscreen(on: Boolean) = runOnUiThread { immersive(on) }

        @android.webkit.JavascriptInterface
        fun keepAwake(on: Boolean) = runOnUiThread {
            if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }

        /** The video gesture controls the Activity window, not only a CSS filter. */
        @android.webkit.JavascriptInterface
        fun getScreenBrightness(): Float {
            val windowValue = window.attributes.screenBrightness
            if (windowValue in 0f..1f) return windowValue
            return try {
                Settings.System.getInt(
                    contentResolver, Settings.System.SCREEN_BRIGHTNESS, 128
                ).coerceIn(0, 255) / 255f
            } catch (e: Exception) { 0.5f }
        }

        @android.webkit.JavascriptInterface
        fun setScreenBrightness(value: Float) = runOnUiThread {
            val attrs = window.attributes
            attrs.screenBrightness = value.coerceIn(0.01f, 1f)
            window.attributes = attrs
        }

        /* ---------------- device volume ----------------
           The in-app slider used to move a Web Audio gain node, which the
           ExoPlayer engine and the YouTube embed never pass through — so it
           changed nothing you could hear. These drive the real media stream. */

        @android.webkit.JavascriptInterface
        fun volumeControl(): Boolean = try {
            !(Build.VERSION.SDK_INT >= 23 && audio.isVolumeFixed)
        } catch (e: Exception) { true }

        @android.webkit.JavascriptInterface
        fun getVolume(): Float = deviceVolume()

        @android.webkit.JavascriptInterface
        fun getVolumeSteps(): Int = maxVolume()

        @android.webkit.JavascriptInterface
        fun setVolume(value: Float) = runOnUiThread {
            try {
                val max = maxVolume()
                val idx = Math.round(value.coerceIn(0f, 1f) * max).coerceIn(0, max)
                audio.setStreamVolume(AudioManager.STREAM_MUSIC, idx, 0)
                lastVolumeSent = idx.toFloat() / max
            } catch (e: Exception) { Log.w(TAG, "volume", e) }
        }

        /* ---------------- YouTube, played by our own engine ---------------- */

        /** True when the shell can stream YouTube through ExoPlayer natively. */
        @android.webkit.JavascriptInterface
        fun ytEngine(): Boolean = true

        /**
         * Open YouTube itself, inside the app. Tapping any video there hands the
         * id back to the player instead of playing it in the page.
         */
        /**
         * Quick inline results for the library search bar (InnerTube, no key and
         * no account). The full YouTube experience is one tap further, in the
         * in-app browser.
         */
        @android.webkit.JavascriptInterface
        fun ytSearch(query: String?, reqId: String?) {
            val q = query.orEmpty()
            val id = reqId.orEmpty()
            thread {
                val list = try { YouTubeStream.search(q) } catch (e: Throwable) {
                    Log.w(TAG, "yt search", e); JSONArray()
                }
                runOnUiThread {
                    web.evaluateJavascript(
                        "window.HashBridge && window.HashBridge.onYtSearch(" +
                            JSONObject.quote(id) + "," + JSONObject.quote(list.toString()) + ");", null
                    )
                }
            }
        }

        @android.webkit.JavascriptInterface
        fun openYouTube(query: String?) = runOnUiThread { openYouTubeBrowser(query.orEmpty()) }

        /**
         * Open any other page (TikTok, Facebook, Instagram, X, a blog…) in the
         * in-app browser and watch it for a playable stream.
         */
        @android.webkit.JavascriptInterface
        fun openWeb(url: String?) = runOnUiThread {
            val u = url.orEmpty()
            if (u.startsWith("http")) openBrowser(u, youtube = false)
        }

        @android.webkit.JavascriptInterface
        fun canDownload(): Boolean = true

        /** Save a YouTube video to the device for offline playback. */
        @android.webkit.JavascriptInterface
        fun ytDownload(videoId: String?, title: String?) {
            val id = videoId.orEmpty()
            if (id.isBlank()) return
            Downloads.start(this@MainActivity, id, title.orEmpty()) { json ->
                runOnUiThread {
                    js("window.HashBridge && window.HashBridge.onDownload(${JSONObject.quote(json)});")
                }
            }
        }

        @android.webkit.JavascriptInterface
        fun share(text: String) = runOnUiThread {
            try {
                startActivity(
                    Intent.createChooser(
                        Intent(Intent.ACTION_SEND).setType("text/plain")
                            .putExtra(Intent.EXTRA_TEXT, text), null
                    )
                )
            } catch (e: Exception) { }
        }

        @android.webkit.JavascriptInterface
        fun openExternal(url: String) = runOnUiThread {
            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (e: Exception) { }
        }

        @android.webkit.JavascriptInterface
        fun exitApp() = runOnUiThread { PlaybackService.stop(this@MainActivity); finishAffinity() }

        /** Explicit mini-player ×: unlike pause, discard the media notification too. */
        @android.webkit.JavascriptInterface
        fun stopPlayback() = runOnUiThread { PlaybackService.stop(this@MainActivity) }

        @android.webkit.JavascriptInterface
        fun toastMsg(msg: String) = runOnUiThread { toast(msg) }

        @android.webkit.JavascriptInterface
        fun version(): String = "2.7.0"

        /* ---------------- native ExoPlayer engine ---------------- */

        /** The web app asks this before routing a device file away from <video>. */
        @android.webkit.JavascriptInterface
        fun nativeEngine(): Boolean = true

        @android.webkit.JavascriptInterface
        fun nLoad(uri: String, pos: Double, autoplay: Boolean, video: Boolean, subtitle: String?) {
            runOnUiThread { webTransparent(video) }
            nativePlayer.load(realUri(uri), uri, pos, autoplay, video, subtitle ?: "")
        }

        /** Turn the (embedded or side-loaded) subtitle track on and off. */
        @android.webkit.JavascriptInterface
        fun nSubs(on: Boolean) = nativePlayer.setSubtitlesEnabled(on)

        /** The 10 equaliser sliders, in dB, applied to the native audio session. */
        @android.webkit.JavascriptInterface
        fun nEq(on: Boolean, gainsJson: String?) {
            val g = FloatArray(10)
            try {
                val a = JSONArray(gainsJson ?: "[]")
                for (i in 0 until minOf(10, a.length())) g[i] = a.optDouble(i, 0.0).toFloat()
            } catch (e: Exception) { }
            nativePlayer.setEq(on, g)
        }

        /**
         * Every other Sound-Lab knob, mirrored onto device audio effects so
         * the settings actually work on the native engine too:
         * {preamp, treble, bass, reverb, boost, anc}
         */
        @android.webkit.JavascriptInterface
        fun nFx(json: String?) {
            val o = try { JSONObject(json ?: "{}") } catch (e: Exception) { return }
            nativePlayer.setFx(
                o.optDouble("preamp", 0.0).toFloat(),
                o.optDouble("treble", 0.0).toFloat(),
                o.optDouble("bass", 0.0).toFloat(),
                o.optDouble("reverb", 0.0).toFloat(),
                o.optDouble("boost", 100.0).toFloat(),
                o.optBoolean("anc", false)
            )
        }

        /** Professional colour grade on/off for the native video surface. */
        @android.webkit.JavascriptInterface
        fun nEnhance(on: Boolean) = nativePlayer.setEnhance(on)

        /**
         * The visualiser taps the audio session, which Android only allows with
         * RECORD_AUDIO. Nothing is ever recorded or sent anywhere — if the user
         * says no we simply leave the bars idle.
         */
        @android.webkit.JavascriptInterface
        fun nVis(on: Boolean) = runOnUiThread {
            if (!on) { nativePlayer.setVisualiser(false); return@runOnUiThread }
            if (ContextCompat.checkSelfPermission(this@MainActivity, "android.permission.RECORD_AUDIO")
                == PackageManager.PERMISSION_GRANTED
            ) nativePlayer.setVisualiser(true)
            else micPermission.launch("android.permission.RECORD_AUDIO")
        }

        @android.webkit.JavascriptInterface
        fun visualiserAllowed(): Boolean =
            ContextCompat.checkSelfPermission(this@MainActivity, "android.permission.RECORD_AUDIO") ==
                PackageManager.PERMISSION_GRANTED

        @android.webkit.JavascriptInterface
        fun nPlay() = nativePlayer.play()

        @android.webkit.JavascriptInterface
        fun nPause() = nativePlayer.pause()

        @android.webkit.JavascriptInterface
        fun nSeek(sec: Double) = nativePlayer.seek(sec)

        @android.webkit.JavascriptInterface
        fun nRate(r: Float) = nativePlayer.rate(r)

        /** Independent pitch (1.0 = original); speed is left alone. */
        @android.webkit.JavascriptInterface
        fun nPitch(p: Float) = nativePlayer.pitch(p)

        @android.webkit.JavascriptInterface
        fun pitchControl(): Boolean = true

        @android.webkit.JavascriptInterface
        fun nVolume(v: Float) = nativePlayer.volume(v)

        /** ExoPlayer's decoder-level silence skipper, controlled from the video panel. */
        @android.webkit.JavascriptInterface
        fun nSkipSilence(on: Boolean) = nativePlayer.setSkipSilence(on)

        @android.webkit.JavascriptInterface
        fun nStop() {
            nativePlayer.stop()
            runOnUiThread { webTransparent(false) }
        }

        /**
         * The player route was pushed/popped. Hiding the TextureView and making
         * the WebView opaque on pop is essential: otherwise the transparent web
         * shell exposes the black native root after the now-playing view leaves.
         */
        @android.webkit.JavascriptInterface
        fun nVideoVisible(visible: Boolean) = runOnUiThread {
            nativePlayer.setVideoVisible(visible)
            webTransparent(visible)
        }

        /** Native equivalent of CSS object-fit: contain / cover / fill. */
        @android.webkit.JavascriptInterface
        fun nResizeMode(mode: String) = nativePlayer.setResizeMode(mode)

        /** Pinch zoom: scale plus a pan expressed as a fraction of the stage. */
        @android.webkit.JavascriptInterface
        fun nZoom(zoom: Float, panX: Float, panY: Float) = nativePlayer.setZoom(zoom, panX, panY)

        /** Where to draw the video, in CSS pixels, so the web UI stays on top of it. */
        @android.webkit.JavascriptInterface
        fun nRect(x: Float, y: Float, w: Float, h: Float) = nativePlayer.setRect(x, y, w, h)

        /* ---------------- artwork ---------------- */

        /**
         * Album art / video thumbnails for the library grid. MediaStore gives us
         * these in one cheap call per file — the web side could never read them,
         * which is why every device track showed a blank tile.
         */
        @android.webkit.JavascriptInterface
        fun requestArt(json: String) {
            thread {
                val list = try { JSONArray(json) } catch (e: Exception) { return@thread }
                for (i in 0 until list.length()) {
                    val u = list.optString(i) ?: continue
                    val data = artFor(realUri(u)) ?: continue
                    runOnUiThread {
                        web.evaluateJavascript(
                            "window.HashBridge && window.HashBridge.onArt(" +
                                JSONObject.quote(u) + "," + JSONObject.quote(data) + ");", null
                        )
                    }
                }
            }
        }
    }

    /** `https://appassets…/media/<encoded content uri>` → the real `content://` uri. */
    private fun realUri(s: String): String {
        val i = s.indexOf(MEDIA_PREFIX)
        return if (i >= 0) Uri.decode(s.substring(i + MEDIA_PREFIX.length)) else s
    }

    /** While a native video is on screen the WebView must be see-through. */
    private fun webTransparent(on: Boolean) {
        web.setBackgroundColor(if (on) Color.TRANSPARENT else Color.parseColor("#07080C"))
    }

    private fun artFor(uri: String): String? {
        val target = try { Uri.parse(uri) } catch (e: Exception) { return null }
        var bmp: Bitmap? = null
        if (Build.VERSION.SDK_INT >= 29) {
            bmp = try { contentResolver.loadThumbnail(target, android.util.Size(320, 320), null) }
            catch (e: Throwable) { null }
        }
        if (bmp == null) {
            val mmr = MediaMetadataRetriever()
            try {
                mmr.setDataSource(this, target)
                val pic = mmr.embeddedPicture
                bmp = if (pic != null) android.graphics.BitmapFactory.decodeByteArray(pic, 0, pic.size)
                else mmr.getFrameAtTime(1_000_000)
            } catch (e: Throwable) { } finally { try { mmr.release() } catch (e: Exception) { } }
        }
        val b = bmp ?: return null
        return try {
            val max = 320
            val scale = minOf(1f, max.toFloat() / maxOf(b.width, b.height))
            val out = if (scale < 1f)
                Bitmap.createScaledBitmap(b, (b.width * scale).toInt(), (b.height * scale).toInt(), true)
            else b
            val bos = ByteArrayOutputStream()
            out.compress(Bitmap.CompressFormat.JPEG, 82, bos)
            "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
        } catch (e: Throwable) { null }
    }

    /* ============================================================
       In-app browser

       Two jobs, one WebView that sits above the player:

       • YouTube — the real m.youtube.com, with its own home feed, search,
         suggestions and ranking. Sign in once (the Sign in button in the bar)
         and the cookies stick, so it behaves like the YouTube app from then
         on. Tapping a video never plays it in the page: we take the id and
         play it in HashPlayer. The whole bar — close, hints, Play here and
         the Google sign-in pill — lives at the BOTTOM of the screen, thumb
         reach, and never covers the top of the page being browsed.

       • Any other site (TikTok, Facebook, Instagram, X, news sites…) — the
         page is shown normally and every request it makes is watched. As soon
         as the real media file appears, a “Play in HashPlayer” button lights
         up in the bar; tapping it plays that stream in our engine with the
         page's own cookies, referer and user agent.
       ============================================================ */

    /** A browser-shaped user agent: Google refuses to sign you in to a "; wv" one. */
    private val browserUa =
        "Mozilla/5.0 (Linux; Android ${Build.VERSION.RELEASE}; ${Build.MODEL}) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36"

    private val MEDIA_FILE = Regex("""\.(m3u8|mpd|mp4|webm|mkv|mov|m4v|mp3|m4a|aac|flac|ogg|opus|wav)(\?|$)""", RegexOption.IGNORE_CASE)

    private var sniffUrl: String? = null
    private var sniffTitle = ""
    private var playBtn: TextView? = null
    private var signInBtn: TextView? = null

    @SuppressLint("SetJavaScriptEnabled")
    private fun openYouTubeBrowser(query: String) {
        val url =
            if (query.isBlank()) "https://m.youtube.com/"
            else "https://m.youtube.com/results?search_query=" +
                java.net.URLEncoder.encode(query, "UTF-8")
        openBrowser(url, youtube = true)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun openBrowser(startUrl: String, youtube: Boolean) {
        ytWeb?.let { it.loadUrl(startUrl); return }
        ytPicked = ""
        sniffUrl = null
        sniffTitle = ""

        val d = resources.displayMetrics.density
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0b0c10"))
            fitsSystemWindows = true
            isClickable = true                       // never leak taps to the player
        }

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding((6 * d).toInt(), (6 * d).toInt(), (6 * d).toInt(), (6 * d).toInt())
            setBackgroundColor(Color.parseColor("#12141c"))
        }
        val close = ImageButton(this).apply {
            setImageResource(android.R.drawable.ic_menu_close_clear_cancel)
            setColorFilter(Color.WHITE)
            background = null
            contentDescription = getString(R.string.yt_close)
            setOnClickListener { closeYouTubeBrowser() }
        }
        val label = TextView(this).apply {
            text = getString(if (youtube) R.string.yt_browse_hint else R.string.web_browse_hint)
            setTextColor(Color.parseColor("#c9ccd6"))
            textSize = 12.5f
            maxLines = 2
            setPadding((10 * d).toInt(), 0, (8 * d).toInt(), 0)
        }
        bar.addView(close, LinearLayout.LayoutParams((40 * d).toInt(), (40 * d).toInt()))
        bar.addView(label, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        /* Lights up the moment a playable stream is spotted on a non-YouTube page. */
        val play = TextView(this).apply {
            text = getString(R.string.web_play_here)
            setTextColor(Color.WHITE)
            textSize = 12.5f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setPadding((12 * d).toInt(), (8 * d).toInt(), (12 * d).toInt(), (8 * d).toInt())
            setBackgroundColor(Color.parseColor("#e62117"))
            visibility = View.GONE
            setOnClickListener { playSniffed() }
        }
        playBtn = play
        bar.addView(play, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        if (youtube) {
            /* A real "Sign in with Google" pill, like other apps show: white
               background, the blue/red/yellow/green G, and it goes straight to
               Google's own account chooser inside this same WebView so the
               session cookie lands where YouTube will read it. */
            val signIn = TextView(this).apply {
                textSize = 12.5f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                setPadding((12 * d).toInt(), (7 * d).toInt(), (12 * d).toInt(), (7 * d).toInt())
                background = android.graphics.drawable.GradientDrawable().apply {
                    cornerRadius = 18 * d
                    setColor(Color.WHITE)
                }
                setOnClickListener { googleSignIn() }
                setOnLongClickListener { googleSignOut(); true }
            }
            signInBtn = signIn
            paintSignIn()
            bar.addView(
                signIn,
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                    .apply { leftMargin = (6 * d).toInt() }
            )
        }

        val wv = WebView(this)
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(false)         // sign-in pop-ups stay in this view
            mediaPlaybackRequiresUserGesture = !youtube
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = browserUa              // a real browser, so Google signs you in
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true)

        wv.webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView?, title: String?) {
                if (!title.isNullOrBlank()) sniffTitle = title
            }
        }
        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url?.toString().orEmpty()
                if (!u.startsWith("http")) return true          // no intent:// hand-offs
                return youtube && takeVideo(u)
            }

            /* YouTube is a single-page app: most taps never load a url, they
               only push a new history entry. This is where we see them. */
            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                if (youtube && takeVideo(url.orEmpty())) return
                super.doUpdateVisitedHistory(view, url, isReload)
            }

            /* Everything the page fetches passes through here — that is how we
               find TikTok's / Facebook's real video file without any scraping. */
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                if (!youtube) noteCandidate(req.url?.toString().orEmpty())
                return null
            }

            override fun onPageFinished(view: WebView, url: String?) {
                CookieManager.getInstance().flush()   // keep the sign-in across restarts
                paintSignIn()
            }
        }

        /* Page on top, control bar underneath — the sign-in pill and friends
           sit at the bottom edge where the thumb already is. */
        column.addView(wv, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        column.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(
            column,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        ytLayer = column
        ytWeb = wv
        nativePlayer.setVideoVisible(false)           // the player's picture stays out of the way
        wv.loadUrl(startUrl)
    }

    /** Is there a Google session in this WebView's cookie jar? */
    private fun signedIn(): Boolean = try {
        val c = CookieManager.getInstance().getCookie("https://m.youtube.com").orEmpty()
        c.contains("SAPISID=") || c.contains("__Secure-3PAPISID=") || c.contains("LOGIN_INFO=")
    } catch (e: Exception) { false }

    private fun paintSignIn() {
        val b = signInBtn ?: return
        val inNow = signedIn()
        b.text = if (inNow) getString(R.string.yt_signed_in) else getString(R.string.yt_sign_in_google)
        b.setTextColor(Color.parseColor(if (inNow) "#1a7f37" else "#1f1f1f"))
    }

    /** Google's own account chooser, in this very WebView. */
    private fun googleSignIn() {
        ytWeb?.loadUrl(
            "https://accounts.google.com/AccountChooser?service=youtube" +
                "&continue=https%3A%2F%2Fm.youtube.com%2F%3Fpersist_app%3D1"
        )
        toast(getString(R.string.yt_sign_in_hint))
    }

    /** Long-press the pill: forget the account on this device. */
    private fun googleSignOut() {
        try {
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
        } catch (e: Exception) { }
        ytWeb?.loadUrl("https://m.youtube.com/")
        paintSignIn()
        toast(getString(R.string.yt_signed_out))
    }

    /** A request that looks like the page's actual media file. */
    private fun noteCandidate(url: String) {
        if (url.length < 12 || !url.startsWith("http")) return
        val lower = url.lowercase()
        val looksMedia = MEDIA_FILE.containsMatchIn(Uri.parse(url).path.orEmpty()) ||
            lower.contains("mime_type=video") || lower.contains(".m3u8") ||
            lower.contains("/video/tos/") || lower.contains("videoplayback")
        if (!looksMedia) return
        if (lower.contains("/ads") || lower.contains("doubleclick")) return
        sniffUrl = url
        runOnUiThread { playBtn?.visibility = View.VISIBLE }
    }

    /** Play the stream this page is using, with its own cookies and referer. */
    private fun playSniffed() {
        val media = sniffUrl ?: return
        val page = ytWeb?.url.orEmpty()
        val cookie = try { CookieManager.getInstance().getCookie(media).orEmpty() } catch (e: Exception) { "" }
        val headers = JSONObject()
            .put("User-Agent", browserUa)
            .put("Referer", page.ifBlank { media })
        if (cookie.isNotBlank()) headers.put("Cookie", cookie)
        NativePlayback.rememberHeaders(media, headers)

        val info = JSONObject()
            .put("url", media)
            .put("title", sniffTitle.ifBlank { Uri.parse(page).host.orEmpty().ifBlank { "Web video" } })
            .put("site", Uri.parse(page.ifBlank { media }).host.orEmpty())
        closeYouTubeBrowser()
        js("window.HashBridge && window.HashBridge.onOpenStream(${JSONObject.quote(info.toString())});")
    }

    /** `true` when this url was a video and has been handed to the player. */
    private fun takeVideo(url: String): Boolean {
        val id = videoIdOf(url) ?: return false
        if (id == ytPicked) return true
        ytPicked = id
        closeYouTubeBrowser()
        val js = "window.HashBridge && window.HashBridge.onYtPick(" + JSONObject.quote(id) + ");"
        web.evaluateJavascript(js, null)
        return true
    }

    private fun videoIdOf(url: String): String? {
        if (url.isBlank()) return null
        val u = try { Uri.parse(url) } catch (e: Exception) { return null }
        val host = u.host.orEmpty().lowercase()
        if (!host.contains("youtube.com") && !host.contains("youtu.be")) return null
        val path = u.path.orEmpty()
        val id = when {
            host.contains("youtu.be") -> path.trim('/').substringBefore('/')
            path.startsWith("/watch") -> u.getQueryParameter("v").orEmpty()
            path.startsWith("/shorts/") -> path.removePrefix("/shorts/").substringBefore('/')
            path.startsWith("/embed/") -> path.removePrefix("/embed/").substringBefore('/')
            path.startsWith("/live/") -> path.removePrefix("/live/").substringBefore('/')
            else -> ""
        }
        return if (id.length in 8..20 && id.all { it.isLetterOrDigit() || it == '-' || it == '_' }) id else null
    }

    private fun closeYouTubeBrowser() {
        val layer = ytLayer ?: return
        val wv = ytWeb
        ytLayer = null
        ytWeb = null
        playBtn = null
        signInBtn = null
        sniffUrl = null
        try { CookieManager.getInstance().flush() } catch (e: Exception) { }
        try {
            wv?.stopLoading()
            wv?.loadUrl("about:blank")
            (wv?.parent as? ViewGroup)?.removeView(wv)
            wv?.destroy()
        } catch (e: Exception) { Log.w(TAG, "yt browser teardown", e) }
        root.removeView(layer)
        // Let the web layer decide whether the picture comes back (it knows
        // which route is on screen); never force the surface over the library.
        web.evaluateJavascript("window.HashBridge && window.HashBridge.onYtBrowser(false);", null)
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    private fun js(code: String) = runOnUiThread {
        if (pageReady) web.evaluateJavascript(code, null) else pending.add(code)
    }

    /* ====================================================== pip / fullscreen */

    private fun safeRatio(w: Int, h: Int): Rational {
        // Android rejects aspect ratios outside roughly 1:2.39 … 2.39:1
        val r = w.toDouble() / h.toDouble()
        val c = r.coerceIn(0.45, 2.35)
        return Rational((c * 1000).toInt(), 1000)
    }

    @SuppressLint("NewApi")
    private fun enterPip(): Boolean {
        if (Build.VERSION.SDK_INT < 26) { toast("Picture-in-picture needs Android 8 or newer"); return false }
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            toast("This device does not support picture-in-picture"); return false
        }
        return try {
            enterPictureInPictureMode(
                PictureInPictureParams.Builder().setAspectRatio(videoRatio).build()
            )
        } catch (e: Exception) { Log.w(TAG, "pip", e); false }
    }

    private fun immersive(on: Boolean) {
        WindowCompat.setDecorFitsSystemWindows(window, !on)
        val c = WindowInsetsControllerCompat(window, window.decorView)
        if (on) {
            c.hide(WindowInsetsCompat.Type.systemBars())
            c.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } else {
            c.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    /* ====================================================== media scan */

    /** Runs once per launch: scan silently if we already have access, otherwise ask once. */
    private fun autoScan() {
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (hasMediaPermission()) { scanDevice(true); return }
        if (prefs.getBoolean(KEY_ASKED, false)) return          // user said no — don't nag every launch
        prefs.edit().putBoolean(KEY_ASKED, true).apply()
        ensureMediaAccess(true)
    }

    private fun neededPermissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= 33)
            arrayOf("android.permission.READ_MEDIA_AUDIO", "android.permission.READ_MEDIA_VIDEO")
        else arrayOf("android.permission.READ_EXTERNAL_STORAGE")

    private fun hasMediaPermission() = neededPermissions().any {
        ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }

    /**
     * Single, unified entry point for the whole "do we have media access yet" flow.
     * Every caller — the automatic post-launch scan *and* the web app's manual/
     * fallback "scanMedia" bridge call — goes through here so that on a fresh
     * install all of [neededPermissions] are requested together in one batched
     * system dialog, and the local scanner only starts once that dialog resolves.
     * The in-flight guard stops a second, near-simultaneous call (e.g. a WebView
     * reload racing the native onPageFinished hook) from interrupting the first
     * request and leaving it truncated to a single permission.
     */
    private fun ensureMediaAccess(silent: Boolean) {
        if (permissionRequestInFlight) return
        val missing = neededPermissions().filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) { scanDevice(silent); return }
        permissionRequestInFlight = true
        pendingScanSilent = silent
        permissions.launch(missing.toTypedArray())
    }

    private fun scanDevice(silent: Boolean) {
        if (!silent) toast(getString(R.string.scanning))
        thread {
            val out = JSONArray()
            try { collect(out, true) } catch (e: Exception) { Log.w(TAG, "audio scan", e) }
            try { collect(out, false) } catch (e: Exception) { Log.w(TAG, "video scan", e) }
            val payload = out.toString()
            runOnUiThread {
                web.evaluateJavascript(
                    "window.HashBridge && window.HashBridge.onScan(${JSONObject.quote(payload)}, $silent);",
                    null
                )
            }
        }
    }

    private fun collect(out: JSONArray, audio: Boolean) {
        val base = if (audio) MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        else MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        val cols = mutableListOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.TITLE,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.MIME_TYPE,
            MediaStore.MediaColumns.DURATION
        )
        if (audio) { cols.add(MediaStore.Audio.Media.ARTIST); cols.add(MediaStore.Audio.Media.ALBUM) }
        if (Build.VERSION.SDK_INT >= 29) cols.add(MediaStore.MediaColumns.RELATIVE_PATH)

        contentResolver.query(
            base, cols.toTypedArray(), null, null,
            MediaStore.MediaColumns.DATE_MODIFIED + " DESC"
        )?.use { c ->
            val idI = c.getColumnIndex(MediaStore.MediaColumns._ID)
            val nameI = c.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME)
            val titleI = c.getColumnIndex(MediaStore.MediaColumns.TITLE)
            val sizeI = c.getColumnIndex(MediaStore.MediaColumns.SIZE)
            val mimeI = c.getColumnIndex(MediaStore.MediaColumns.MIME_TYPE)
            val durI = c.getColumnIndex(MediaStore.MediaColumns.DURATION)
            val artI = if (audio) c.getColumnIndex(MediaStore.Audio.Media.ARTIST) else -1
            val albI = if (audio) c.getColumnIndex(MediaStore.Audio.Media.ALBUM) else -1
            val pathI = c.getColumnIndex(MediaStore.MediaColumns.RELATIVE_PATH)

            while (c.moveToNext()) {
                val dur = if (durI >= 0) c.getLong(durI) else 0L
                if (dur in 1..4999) continue                       // skip notification blips
                val id = c.getLong(idI)
                val uri = ContentUris.withAppendedId(base, id)
                val o = JSONObject()
                o.put("uri", "$ORIGIN$MEDIA_PREFIX" + Uri.encode(uri.toString()))
                o.put("name", if (nameI >= 0) c.getString(nameI) ?: "Track" else "Track")
                o.put("title", if (titleI >= 0) c.getString(titleI) ?: "" else "")
                o.put("artist", if (artI >= 0) (c.getString(artI) ?: "").replace("<unknown>", "") else "")
                o.put("album", if (albI >= 0) c.getString(albI) ?: "" else "")
                o.put("size", if (sizeI >= 0) c.getLong(sizeI) else 0)
                o.put("mime", if (mimeI >= 0) c.getString(mimeI) ?: "" else "")
                o.put("duration", dur)
                o.put("kind", if (audio) "audio" else "video")
                o.put("folder", if (pathI >= 0) c.getString(pathI) ?: "" else "")
                out.put(o)
            }
        }
    }

    /* ====================================================== content:// streaming with Range */

    private fun mediaResponse(request: WebResourceRequest): WebResourceResponse? {
        val path = request.url.path ?: return null
        return try {
            val target = Uri.parse(Uri.decode(path.substring(MEDIA_PREFIX.length)))
            val cr = contentResolver
            val mime = cr.getType(target) ?: guessMime(target.toString())

            // A seekable descriptor lets us jump straight to the requested byte instead of
            // reading (and throwing away) everything before it — this is what makes
            // scrubbing through a large video instant rather than a multi-second freeze.
            val pfd: ParcelFileDescriptor? = try { cr.openFileDescriptor(target, "r") } catch (e: Exception) { null }
            val total = pfd?.statSize ?: -1L

            val rangeHeader = request.requestHeaders.entries
                .firstOrNull { it.key.equals("Range", true) }?.value
            var start = 0L
            var end = if (total > 0) total - 1 else -1L
            var partial = false
            if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
                val p = rangeHeader.removePrefix("bytes=").split("-")
                start = p.getOrNull(0)?.trim()?.toLongOrNull() ?: 0L
                p.getOrNull(1)?.trim()?.toLongOrNull()?.let { end = it }
                partial = true
            }
            if (total > 0 && (end < 0 || end > total - 1)) end = total - 1
            if (start < 0) start = 0
            if (total > 0 && start >= total) {
                pfd?.close()
                return WebResourceResponse(
                    mime, null, 416, "Range Not Satisfiable",
                    hashMapOf("Content-Range" to "bytes */$total"), null
                )
            }

            val raw: InputStream = if (pfd != null) {
                val fis = ParcelFileDescriptor.AutoCloseInputStream(pfd)
                if (start > 0) {
                    try { fis.channel.position(start) }
                    catch (e: Exception) { skipFully(fis, start) }   // non-seekable provider
                }
                fis
            } else {
                val s = cr.openInputStream(target) ?: return null
                if (start > 0) skipFully(s, start)
                s
            }

            val length = if (total > 0) end - start + 1 else -1L
            val buffered = BufferedInputStream(raw, 256 * 1024)
            val body: InputStream = if (length > 0) Limited(buffered, length) else buffered

            val headers = HashMap<String, String>()
            headers["Accept-Ranges"] = "bytes"
            headers["Cache-Control"] = "no-store"
            headers["Access-Control-Allow-Origin"] = ORIGIN
            if (length > 0) headers["Content-Length"] = length.toString()
            if (partial && total > 0) headers["Content-Range"] = "bytes $start-$end/$total"

            WebResourceResponse(
                mime, null,
                if (partial) 206 else 200,
                if (partial) "Partial Content" else "OK",
                headers, body
            )
        } catch (e: Exception) {
            Log.w(TAG, "media stream failed", e)
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
        }
    }

    private fun guessMime(s: String): String = when (s.substringAfterLast('.', "").lowercase()) {
        "mp3" -> "audio/mpeg"; "m4a", "aac" -> "audio/mp4"; "flac" -> "audio/flac"
        "wav" -> "audio/wav"; "ogg", "oga" -> "audio/ogg"; "opus" -> "audio/opus"
        "mp4", "m4v" -> "video/mp4"; "webm" -> "video/webm"; "mkv" -> "video/x-matroska"
        "3gp" -> "video/3gpp"; "mov" -> "video/quicktime"
        else -> "application/octet-stream"
    }

    private fun skipFully(input: InputStream, bytes: Long) {
        var left = bytes
        while (left > 0) {
            val n = input.skip(left)
            if (n <= 0) { if (input.read() < 0) break else left-- } else left -= n
        }
    }

    private class Limited(src: InputStream, private var left: Long) : FilterInputStream(src) {
        override fun read(): Int {
            if (left <= 0) return -1
            val b = super.read()
            if (b >= 0) left--
            return b
        }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (left <= 0) return -1
            val n = super.read(b, off, minOf(len.toLong(), left).toInt())
            if (n > 0) left -= n
            return n
        }
        override fun available(): Int = minOf(super.available().toLong(), left).toInt()
    }

    /* ====================================================== incoming intents */

    @SuppressLint("NewApi")
    private fun handleIntent(intent: Intent?) {
        intent ?: return
        val action = intent.action
        if (action != Intent.ACTION_VIEW && action != Intent.ACTION_SEND &&
            action != Intent.ACTION_SEND_MULTIPLE
        ) return
        when (action) {
            Intent.ACTION_VIEW -> {
                val d = intent.data ?: return
                if (d.scheme == "http" || d.scheme == "https") openLink(d.toString())
                else openUris(listOf(d))
            }
            Intent.ACTION_SEND -> {
                @Suppress("DEPRECATION")
                val stream = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
                if (stream != null) openUris(listOf(stream))
                else {
                    val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
                    val link = LINK.find(text)?.value
                    if (link != null) openLink(link.trimEnd('.', ',', ')'))
                    else toast("No playable link found in that share")
                }
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                @Suppress("DEPRECATION")
                val list = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: return
                openUris(list)
            }
        }
        intent.action = null      // don't replay the same intent after a rotation
    }

    /** A shared/opened web link (YouTube page, direct mp4, radio stream…). */
    private fun openLink(url: String) {
        js("window.HashBridge && window.HashBridge.onOpenLink(${JSONObject.quote(url)});")
    }

    private fun openUris(uris: List<Uri>) {
        val arr = JSONArray()
        uris.forEach { data ->
            try {
                contentResolver.takePersistableUriPermission(data, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (e: Exception) { /* not persistable — still playable right now */ }

            var name = data.lastPathSegment?.substringAfterLast('/') ?: "Track"
            var size = 0L
            try {
                contentResolver.query(data, null, null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        val s = c.getColumnIndex(OpenableColumns.SIZE)
                        if (n >= 0) name = c.getString(n) ?: name
                        if (s >= 0) size = c.getLong(s)
                    }
                }
            } catch (e: Exception) { }

            val mime = contentResolver.getType(data) ?: guessMime(name)
            arr.put(
                JSONObject()
                    .put("uri", "$ORIGIN$MEDIA_PREFIX" + Uri.encode(data.toString()))
                    .put("name", name).put("title", "").put("artist", "").put("album", "")
                    .put("size", size).put("mime", mime).put("duration", 0)
                    .put("kind", if (mime.startsWith("video")) "video" else "audio")
            )
        }
        if (arr.length() == 0) return
        js("window.HashBridge && window.HashBridge.onOpenUri(${JSONObject.quote(arr.toString())});")
    }
}
