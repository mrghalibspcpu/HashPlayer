package com.mrghalibspcpu.hashplayer

import android.annotation.SuppressLint
import android.content.ContentUris
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebViewClient
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
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
 *   • MediaStore scan of every song / video on the device
 *   • streaming those content:// files to the <video> tag *with* Range support
 *   • a real file picker for <input type="file">
 *   • a media-session notification + foreground service for background playback
 *   • hardware back button handling
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "HashPlayer"
        const val ORIGIN = "https://appassets.androidplatform.net"
        const val START_URL = "$ORIGIN/assets/www/index.html"
        private const val MEDIA_PREFIX = "/media/"
    }

    private lateinit var web: WebView
    private lateinit var loader: WebViewAssetLoader
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var pageReady = false
    private var pendingOpen: String? = null
    private var isPlaying = false
    private var lastBackPress = 0L

    private val fileChooser =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
            val cb = filePathCallback
            filePathCallback = null
            cb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res.resultCode, res.data))
        }

    private val permissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            if (grants.values.any { it }) scanDevice()
            else toast(getString(R.string.need_permission))
        }

    private val notifPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

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
        setContentView(web)

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
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            textZoom = 100
            userAgentString = "$userAgentString HashPlayer/2.0"
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

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                external(request.url)

            @Deprecated("kept for API 23", ReplaceWith(""))
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
                external(Uri.parse(url))

            private fun external(u: Uri): Boolean {
                if (u.host == "appassets.androidplatform.net") return false
                return try {                            // anything external opens in the browser
                    startActivity(Intent(Intent.ACTION_VIEW, u)); true
                } catch (e: Exception) { true }
            }

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                pendingOpen?.let { js -> view.evaluateJavascript(js, null); pendingOpen = null }
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

            override fun onPermissionRequest(request: PermissionRequest) = request.deny()

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
        handleViewIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleViewIntent(intent)
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

    override fun onDestroy() {
        PlaybackService.transport = null
        PlaybackService.stop(this)
        web.destroy()
        super.onDestroy()
    }

    /* ====================================================== JS bridge */

    inner class Bridge {
        @android.webkit.JavascriptInterface
        fun scanMedia() = runOnUiThread { requestMediaPermission() }

        @android.webkit.JavascriptInterface
        fun setPlaybackState(playing: Boolean, title: String?, artist: String?) = runOnUiThread {
            isPlaying = playing
            if (playing && Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this@MainActivity, "android.permission.POST_NOTIFICATIONS")
                != PackageManager.PERMISSION_GRANTED
            ) notifPermission.launch("android.permission.POST_NOTIFICATIONS")
            PlaybackService.update(this@MainActivity, playing, title ?: "", artist ?: "")
        }

        @android.webkit.JavascriptInterface
        fun exitApp() = runOnUiThread { PlaybackService.stop(this@MainActivity); finishAffinity() }

        @android.webkit.JavascriptInterface
        fun toastMsg(msg: String) = runOnUiThread { toast(msg) }

        @android.webkit.JavascriptInterface
        fun version(): String = "2.0.0"
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    /* ====================================================== media scan */

    private fun requestMediaPermission() {
        val needed = if (Build.VERSION.SDK_INT >= 33)
            arrayOf("android.permission.READ_MEDIA_AUDIO", "android.permission.READ_MEDIA_VIDEO")
        else arrayOf("android.permission.READ_EXTERNAL_STORAGE")
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) scanDevice() else permissions.launch(missing.toTypedArray())
    }

    private fun scanDevice() {
        toast(getString(R.string.scanning))
        thread {
            val out = JSONArray()
            try { collect(out, true) } catch (e: Exception) { Log.w(TAG, "audio scan", e) }
            try { collect(out, false) } catch (e: Exception) { Log.w(TAG, "video scan", e) }
            val payload = out.toString()
            runOnUiThread {
                web.evaluateJavascript(
                    "window.HashBridge && window.HashBridge.onScan(${JSONObject.quote(payload)});", null
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
            val mime = cr.getType(target) ?: "application/octet-stream"
            val total = cr.openFileDescriptor(target, "r")?.use { it.statSize } ?: -1L

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

            val input = cr.openInputStream(target) ?: return null
            if (start > 0) skipFully(input, start)
            val length = if (total > 0) end - start + 1 else -1L
            val body: InputStream = if (length > 0) Limited(input, length) else input

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

    /* ====================================================== "open with" intent */

    private fun handleViewIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (intent.action != Intent.ACTION_VIEW) return
        try {
            contentResolver.takePersistableUriPermission(data, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (e: Exception) { /* not persistable — still playable right now */ }

        var name = data.lastPathSegment ?: "Track"
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

        val mime = contentResolver.getType(data) ?: ""
        val o = JSONObject()
            .put("uri", "$ORIGIN$MEDIA_PREFIX" + Uri.encode(data.toString()))
            .put("name", name).put("title", "").put("artist", "").put("album", "")
            .put("size", size).put("mime", mime).put("duration", 0)
            .put("kind", if (mime.startsWith("video")) "video" else "audio")
        val js = "window.HashBridge && window.HashBridge.onOpenUri(${JSONObject.quote(o.toString())});"
        if (pageReady) web.evaluateJavascript(js, null) else pendingOpen = js
    }
}
