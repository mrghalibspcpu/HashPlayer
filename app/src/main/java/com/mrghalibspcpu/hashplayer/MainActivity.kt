package com.mrghalibspcpu.hashplayer

import android.annotation.SuppressLint
import android.app.PictureInPictureParams
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.provider.OpenableColumns
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
import android.widget.Toast
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
import java.io.BufferedInputStream
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
        private val BAD_NAME = Regex("""[\\/:*?"<>|\r\n\t]""")
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
    private val server by lazy { MediaServer(this) }
    private var serverPort = 0

    private val fileChooser =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
            val cb = filePathCallback
            filePathCallback = null
            cb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res.resultCode, res.data))
        }

    private val permissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            if (grants.values.any { it }) scanDevice(false)
            else toast(getString(R.string.need_permission))
        }

    private val notifPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    /* ====================================================== lifecycle */

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        serverPort = try { server.start() } catch (e: Exception) { 0 }

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
            // The loopback media server is http://127.0.0.1 — a secure origin per spec, but
            // WebView still needs to be told it may be mixed with the https asset origin.
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            textZoom = 100
            userAgentString = "$userAgentString HashPlayer/2.2"
        }
        // Keep the page rasterised while it is off-screen (PiP, notification shade, rotation):
        // without this the WebView can throw away its surface mid-video and stall playback.
        try { WebView.setWebContentsDebuggingEnabled(false) } catch (e: Exception) { }
        try { web.settings.setOffscreenPreRaster(true) } catch (e: Exception) { }

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
                web.evaluateJavascript("window.HashBridge && window.HashBridge.onTransport('$action');", null)
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (customView != null) { web.webChromeClient?.onHideCustomView(); return }
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

        if (savedInstanceState == null) web.loadUrl(START_URL) else web.restoreState(savedInstanceState)
        handleIntent(intent)
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
        // Pausing the WebView kills decoding, so only ever do it when nothing is playing.
        if (!isPlaying) { web.onPause(); web.pauseTimers() }
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
        val land = newConfig.orientation == Configuration.ORIENTATION_LANDSCAPE
        js("window.HashBridge && window.HashBridge.onRotate($land);")
    }

    override fun onDestroy() {
        try { server.stop() } catch (e: Exception) { }
        PlaybackService.transport = null
        PlaybackService.stop(this)
        web.destroy()
        super.onDestroy()
    }

    /* ====================================================== JS bridge */

    inner class Bridge {
        @android.webkit.JavascriptInterface
        fun scanMedia() = runOnUiThread { requestMediaPermission(false) }

        @android.webkit.JavascriptInterface
        fun setPlaybackState(playing: Boolean, title: String?, artist: String?) = runOnUiThread {
            isPlaying = playing
            if (playing && Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this@MainActivity, "android.permission.POST_NOTIFICATIONS")
                != PackageManager.PERMISSION_GRANTED
            ) notifPermission.launch("android.permission.POST_NOTIFICATIONS")
            PlaybackService.update(this@MainActivity, playing, title ?: "", artist ?: "")
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

        @android.webkit.JavascriptInterface
        fun toastMsg(msg: String) = runOnUiThread { toast(msg) }

        @android.webkit.JavascriptInterface
        fun version(): String = "2.2.0"

        /* ---------------- loopback media server ---------------- */

        /** Playable http://127.0.0.1 URL for a content:// uri (falls back to the asset origin). */
        @android.webkit.JavascriptInterface
        fun mediaUrl(uri: String): String = try {
            val u = normalizeUri(uri)
            if (serverPort > 0) server.mediaUrl(u) else "$ORIGIN$MEDIA_PREFIX" + Uri.encode(u)
        } catch (e: Exception) { "" }

        /** Album art / poster frame for a content:// uri, or "" when there is none. */
        @android.webkit.JavascriptInterface
        fun thumbUrl(uri: String, kind: String): String = try {
            if (serverPort > 0) server.thumbUrl(normalizeUri(uri), if (kind == "video") "video" else "audio") else ""
        } catch (e: Exception) { "" }

        @android.webkit.JavascriptInterface
        fun serverPort(): Int = serverPort

        /* ---------------- downloads (YouTube & direct links) ---------------- */

        @android.webkit.JavascriptInterface
        fun download(url: String, fileName: String, mime: String): Boolean =
            this@MainActivity.download(url, fileName, mime)

        @android.webkit.JavascriptInterface
        fun canDownload(): Boolean = true
    }

    /** Old library rows stored the asset-origin wrapper — unwrap them back to content://. */
    private fun normalizeUri(raw: String): String {
        var u = raw
        val marker = "$ORIGIN$MEDIA_PREFIX"
        if (u.startsWith(marker)) u = Uri.decode(u.substring(marker.length))
        else if (u.startsWith(MEDIA_PREFIX)) u = Uri.decode(u.substring(MEDIA_PREFIX.length))
        val q = u.indexOf("?n=")                       // cache-busting token added by the web app
        if (q > 0 && u.startsWith("content://")) u = u.substring(0, q)
        return u
    }

    /** Hand a direct media URL to Android's own download manager. */
    private fun download(url: String, fileNameRaw: String, mime: String): Boolean {
        return try {
            val cleaned = fileNameRaw.replace(BAD_NAME, "_").trim().take(120)
            val safe = if (cleaned.isBlank()) "HashPlayer-" + System.currentTimeMillis() else cleaned
            val video = mime.startsWith("video") || safe.endsWith(".mp4") || safe.endsWith(".webm")
            val dir = if (video) android.os.Environment.DIRECTORY_MOVIES else android.os.Environment.DIRECTORY_MUSIC
            val req = android.app.DownloadManager.Request(Uri.parse(url))
                .setTitle(safe)
                .setDescription(getString(R.string.app_name))
                .setAllowedOverRoaming(true)
                .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(dir, "HashPlayer/" + safe)
            if (mime.isNotBlank()) req.setMimeType(mime)
            req.addRequestHeader("User-Agent", web.settings.userAgentString)
            val dm = getSystemService(Context.DOWNLOAD_SERVICE) as android.app.DownloadManager
            dm.enqueue(req)
            runOnUiThread { toast(getString(R.string.download_started)) }
            true
        } catch (e: Exception) {
            Log.w(TAG, "download", e)
            runOnUiThread { toast(getString(R.string.download_failed)) }
            false
        }
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
        requestMediaPermission(true)
    }

    private fun neededPermissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= 33)
            arrayOf("android.permission.READ_MEDIA_AUDIO", "android.permission.READ_MEDIA_VIDEO")
        else arrayOf("android.permission.READ_EXTERNAL_STORAGE")

    private fun hasMediaPermission() = neededPermissions().any {
        ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }

    private fun requestMediaPermission(silent: Boolean) {
        val missing = neededPermissions().filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) scanDevice(silent) else permissions.launch(missing.toTypedArray())
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
                // Store the bare content:// uri: the loopback port changes every launch,
                // so the web app asks for a fresh playable URL right before it plays.
                o.put("uri", uri.toString())
                o.put("thumb", if (serverPort > 0) server.thumbUrl(uri.toString(), if (audio) "audio" else "video") else "")
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
                    .put("uri", data.toString())
                    .put("thumb", if (serverPort > 0) server.thumbUrl(data.toString(), if (mime.startsWith("video")) "video" else "audio") else "")
                    .put("name", name).put("title", "").put("artist", "").put("album", "")
                    .put("size", size).put("mime", mime).put("duration", 0)
                    .put("kind", if (mime.startsWith("video")) "video" else "audio")
            )
        }
        if (arr.length() == 0) return
        js("window.HashBridge && window.HashBridge.onOpenUri(${JSONObject.quote(arr.toString())});")
    }
}
