package com.mrghalibspcpu.hashplayer

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.app.PictureInPictureParams
import android.content.ContentUris
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Log
import android.util.Rational
import android.util.Size
import android.view.View
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
import java.io.BufferedInputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.FileInputStream
import java.io.FilterInputStream
import java.io.InputStream
import java.util.regex.Pattern
import kotlin.concurrent.thread

/**
 * HashPlayer — native Android shell.
 *
 * Provides:
 *   • Fast, stutter-free MediaStore scanning & random-access Range streaming
 *   • Automatic native video/audio thumbnail extraction (/thumbnail/ endpoint)
 *   • Full Picture-in-Picture (PiP) support with auto-PiP on home/minimize
 *   • "Open with" and YouTube Share integration (ACTION_VIEW, ACTION_SEND)
 *   • Native DownloadManager for saving YouTube & web videos/audios to device
 *   • MediaSession & foreground service for background audio
 *   • Hardware-accelerated WebView rendering
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "HashPlayer"
        const val ORIGIN = "https://appassets.androidplatform.net"
        const val START_URL = "$ORIGIN/assets/www/index.html"
        private const val MEDIA_PREFIX = "/media/"
        private const val THUMB_PREFIX = "/thumbnail/"
    }

    private lateinit var web: WebView
    private lateinit var loader: WebViewAssetLoader
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var pageReady = false
    private var pendingJsQueue = mutableListOf<String>()
    private var isPlaying = false
    private var isVideoPlaying = false
    private var lastBackPress = 0L
    private var isScanning = false

    private val fileChooser =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
            val cb = filePathCallback
            filePathCallback = null
            cb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res.resultCode, res.data))
        }

    private val permissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            if (grants.values.any { it }) {
                scanDevice(quiet = false)
            } else {
                toast(getString(R.string.need_permission))
            }
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
            isHorizontalScrollBarEnabled = false
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
        }
        setContentView(web)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            allowFileAccess = true
            allowContentAccess = true
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            textZoom = 100
            userAgentString = "$userAgentString HashPlayer/2.1"
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView, request: WebResourceRequest
            ): WebResourceResponse? {
                val url = request.url
                if (url.host == "appassets.androidplatform.net") {
                    val path = url.path ?: ""
                    if (path.startsWith(MEDIA_PREFIX)) return mediaResponse(request)
                    if (path.startsWith(THUMB_PREFIX)) return thumbnailResponse(request)
                }
                return loader.shouldInterceptRequest(url)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                external(request.url)

            @Deprecated("kept for API 23", ReplaceWith(""))
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
                external(Uri.parse(url))

            private fun external(u: Uri): Boolean {
                if (u.host == "appassets.androidplatform.net") return false
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, u))
                    true
                } catch (e: Exception) {
                    true
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                drainPendingJs()
                if (hasMediaPermission()) {
                    scanDevice(quiet = true)
                }
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
                        arrayOf(
                            "audio/*", "video/*", "text/plain", "application/x-subrip",
                            "application/ogg", "application/x-flac", "application/x-matroska"
                        )
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
        if (!isPlaying) {
            web.onPause()
            web.pauseTimers()
        }
    }

    override fun onResume() {
        super.onResume()
        web.resumeTimers()
        web.onResume()
    }

    override fun onDestroy() {
        PlaybackService.transport = null
        PlaybackService.stop(this)
        web.destroy()
        super.onDestroy()
    }

    /* ====================================================== PiP support */

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && isPlaying && isVideoPlaying) {
            enterPipModeInternal()
        }
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: Configuration
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        runOnUiThread {
            web.evaluateJavascript(
                "window.HashBridge && window.HashBridge.onPipMode($isInPictureInPictureMode);",
                null
            )
        }
    }

    private fun enterPipModeInternal() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                val params = PictureInPictureParams.Builder()
                    .setAspectRatio(Rational(16, 9))
                    .build()
                enterPictureInPictureMode(params)
            } catch (e: Exception) {
                Log.w(TAG, "enterPiP failed: ${e.message}")
            }
        }
    }

    /* ====================================================== JS bridge */

    inner class Bridge {
        @android.webkit.JavascriptInterface
        fun autoScan() = runOnUiThread {
            if (hasMediaPermission()) {
                scanDevice(quiet = true)
            } else {
                requestMediaPermission(quiet = true)
            }
        }

        @android.webkit.JavascriptInterface
        fun scanMedia() = runOnUiThread {
            requestMediaPermission(quiet = false)
        }

        @android.webkit.JavascriptInterface
        fun enterPip() = runOnUiThread {
            enterPipModeInternal()
        }

        @android.webkit.JavascriptInterface
        fun setPlaybackState(
            playing: Boolean,
            title: String?,
            artist: String?,
            isVideo: Boolean? = false
        ) = runOnUiThread {
            isPlaying = playing
            isVideoPlaying = isVideo ?: false
            if (playing && Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(
                    this@MainActivity,
                    "android.permission.POST_NOTIFICATIONS"
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                notifPermission.launch("android.permission.POST_NOTIFICATIONS")
            }
            PlaybackService.update(this@MainActivity, playing, title ?: "", artist ?: "")
        }

        @android.webkit.JavascriptInterface
        fun downloadMedia(url: String, title: String, mimeType: String, isAudio: Boolean) = runOnUiThread {
            try {
                val cleanTitle = title.ifBlank { "Media" }.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim()
                val ext = if (isAudio) ".mp3" else ".mp4"
                val fileName = if (cleanTitle.endsWith(ext, true)) cleanTitle else "$cleanTitle$ext"
                val dm = getSystemService(DOWNLOAD_SERVICE) as DownloadManager
                val req = DownloadManager.Request(Uri.parse(url)).apply {
                    setTitle(cleanTitle)
                    setDescription("Downloading in HashPlayer")
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setDestinationInExternalPublicDir(
                        if (isAudio) Environment.DIRECTORY_MUSIC else Environment.DIRECTORY_DOWNLOADS,
                        fileName
                    )
                    setMimeType(if (mimeType.isNotBlank()) mimeType else (if (isAudio) "audio/mpeg" else "video/mp4"))
                    setAllowedOverMetered(true)
                    setAllowedOverRoaming(true)
                }
                dm.enqueue(req)
                toast("Download started: $cleanTitle")
            } catch (e: Exception) {
                Log.w(TAG, "Download failed", e)
                toast("Download failed: ${e.message}")
            }
        }

        @android.webkit.JavascriptInterface
        fun exitApp() = runOnUiThread {
            PlaybackService.stop(this@MainActivity)
            finishAffinity()
        }

        @android.webkit.JavascriptInterface
        fun toastMsg(msg: String) = runOnUiThread {
            toast(msg)
        }

        @android.webkit.JavascriptInterface
        fun version(): String = "2.1.0"
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    private fun runJs(js: String) {
        if (pageReady) {
            web.evaluateJavascript(js, null)
        } else {
            pendingJsQueue.add(js)
        }
    }

    private fun drainPendingJs() {
        while (pendingJsQueue.isNotEmpty()) {
            val js = pendingJsQueue.removeAt(0)
            web.evaluateJavascript(js, null)
        }
    }

    /* ====================================================== media scan */

    private fun hasMediaPermission(): Boolean {
        val needed = if (Build.VERSION.SDK_INT >= 33) {
            arrayOf("android.permission.READ_MEDIA_AUDIO", "android.permission.READ_MEDIA_VIDEO")
        } else {
            arrayOf("android.permission.READ_EXTERNAL_STORAGE")
        }
        return needed.all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun requestMediaPermission(quiet: Boolean = false) {
        val needed = if (Build.VERSION.SDK_INT >= 33) {
            arrayOf("android.permission.READ_MEDIA_AUDIO", "android.permission.READ_MEDIA_VIDEO")
        } else {
            arrayOf("android.permission.READ_EXTERNAL_STORAGE")
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            scanDevice(quiet = quiet)
        } else {
            permissions.launch(missing.toTypedArray())
        }
    }

    private fun scanDevice(quiet: Boolean = false) {
        if (isScanning) return
        isScanning = true
        if (!quiet) toast(getString(R.string.scanning))
        thread {
            val out = JSONArray()
            try { collect(out, true) } catch (e: Exception) { Log.w(TAG, "audio scan failed", e) }
            try { collect(out, false) } catch (e: Exception) { Log.w(TAG, "video scan failed", e) }
            val payload = out.toString()
            isScanning = false
            runOnUiThread {
                runJs("window.HashBridge && window.HashBridge.onScan(${JSONObject.quote(payload)});")
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
        if (audio) {
            cols.add(MediaStore.Audio.Media.ARTIST)
            cols.add(MediaStore.Audio.Media.ALBUM)
        }
        if (Build.VERSION.SDK_INT >= 29) {
            cols.add(MediaStore.MediaColumns.RELATIVE_PATH)
        }

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
                if (dur in 1..2999) continue
                val id = c.getLong(idI)
                val uri = ContentUris.withAppendedId(base, id)
                val o = JSONObject()
                o.put("uri", "$ORIGIN$MEDIA_PREFIX" + Uri.encode(uri.toString()))
                o.put("cover", "$ORIGIN$THUMB_PREFIX" + Uri.encode(uri.toString()))
                o.put("name", if (nameI >= 0) c.getString(nameI) ?: "Track" else "Track")
                o.put("title", if (titleI >= 0) c.getString(titleI) ?: "" else "")
                o.put("artist", if (artI >= 0) (c.getString(artI) ?: "").replace("<unknown>", "").trim() else "")
                o.put("album", if (albI >= 0) (c.getString(albI) ?: "").replace("<unknown>", "").trim() else "")
                o.put("size", if (sizeI >= 0) c.getLong(sizeI) else 0)
                o.put("mime", if (mimeI >= 0) c.getString(mimeI) ?: "" else "")
                o.put("duration", dur)
                o.put("kind", if (audio) "audio" else "video")
                o.put("folder", if (pathI >= 0) c.getString(pathI) ?: "" else "")
                out.put(o)
            }
        }
    }

    /* ====================================================== thumbnail extraction */

    private fun thumbnailResponse(request: WebResourceRequest): WebResourceResponse? {
        val path = request.url.path ?: return null
        return try {
            val targetUri = Uri.parse(Uri.decode(path.substring(THUMB_PREFIX.length)))
            var bmp: Bitmap? = null

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    bmp = contentResolver.loadThumbnail(targetUri, Size(400, 400), null)
                } catch (_: Exception) {}
            }

            if (bmp == null) {
                val retriever = MediaMetadataRetriever()
                try {
                    retriever.setDataSource(this, targetUri)
                    val art = retriever.embeddedPicture
                    if (art != null) {
                        val headers = HashMap<String, String>()
                        headers["Cache-Control"] = "public, max-age=86400"
                        headers["Access-Control-Allow-Origin"] = ORIGIN
                        return WebResourceResponse(
                            "image/jpeg", null, 200, "OK", headers,
                            ByteArrayInputStream(art)
                        )
                    }
                    bmp = retriever.getFrameAtTime(1000000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                        ?: retriever.frameAtTime
                } catch (_: Exception) {} finally {
                    try { retriever.release() } catch (_: Exception) {}
                }
            }

            if (bmp != null) {
                val baos = ByteArrayOutputStream()
                bmp.compress(Bitmap.CompressFormat.JPEG, 85, baos)
                val bytes = baos.toByteArray()
                val headers = HashMap<String, String>()
                headers["Cache-Control"] = "public, max-age=86400"
                headers["Access-Control-Allow-Origin"] = ORIGIN
                WebResourceResponse(
                    "image/jpeg", null, 200, "OK", headers,
                    ByteArrayInputStream(bytes)
                )
            } else {
                WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
            }
        } catch (e: Exception) {
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
        }
    }

    /* ====================================================== content:// streaming with instant O(1) Range seek */

    private fun mediaResponse(request: WebResourceRequest): WebResourceResponse? {
        val path = request.url.path ?: return null
        var pfd: ParcelFileDescriptor? = null
        var fis: FileInputStream? = null
        return try {
            val target = Uri.parse(Uri.decode(path.substring(MEDIA_PREFIX.length)))
            val cr = contentResolver
            val mime = cr.getType(target) ?: "application/octet-stream"
            pfd = cr.openFileDescriptor(target, "r") ?: return null
            val total = pfd.statSize

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
            if (total > 0 && start > end) start = end

            fis = FileInputStream(pfd.fileDescriptor)
            if (start > 0) {
                fis.channel.position(start)
            }

            val length = if (total > 0 && end >= start) end - start + 1 else -1L
            val limitedStream = LimitedStream(fis, length, pfd)
            val body: InputStream = BufferedInputStream(limitedStream, 64 * 1024)

            val headers = HashMap<String, String>()
            headers["Accept-Ranges"] = "bytes"
            headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            headers["Access-Control-Allow-Origin"] = ORIGIN
            headers["Access-Control-Allow-Headers"] = "Range, Origin, Content-Type, Accept"
            headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS"
            if (length > 0) headers["Content-Length"] = length.toString()
            if (partial && total > 0) headers["Content-Range"] = "bytes $start-$end/$total"

            // ENCODING MUST BE NULL FOR BINARY STREAMS
            WebResourceResponse(
                mime, null,
                if (partial) 206 else 200,
                if (partial) "Partial Content" else "OK",
                headers, body
            )
        } catch (e: Exception) {
            Log.w(TAG, "media stream failed: ${e.message}")
            try { fis?.close() } catch (_: Exception) {}
            try { pfd?.close() } catch (_: Exception) {}
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
        }
    }

    private class LimitedStream(
        src: InputStream,
        private var left: Long,
        private val pfd: ParcelFileDescriptor?
    ) : FilterInputStream(src) {
        override fun read(): Int {
            if (left == 0L) return -1
            val b = super.read()
            if (b >= 0 && left > 0) left--
            return b
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (left == 0L) return -1
            val toRead = if (left > 0) minOf(len.toLong(), left).toInt() else len
            val n = super.read(b, off, toRead)
            if (n > 0 && left > 0) left -= n
            return n
        }

        override fun available(): Int =
            if (left >= 0) minOf(super.available().toLong(), left).toInt() else super.available()

        override fun close() {
            try { super.close() } catch (_: Exception) {}
            try { pfd?.close() } catch (_: Exception) {}
        }
    }

    /* ====================================================== "open with" & YouTube share intents */

    private fun handleIntent(intent: Intent?) {
        if (intent == null) return
        val action = intent.action
        when (action) {
            Intent.ACTION_VIEW -> {
                val data = intent.data ?: return
                val scheme = data.scheme?.lowercase()
                if (scheme == "http" || scheme == "https") {
                    openUrlInPlayer(data.toString())
                } else {
                    openUriInPlayer(data)
                }
            }
            Intent.ACTION_SEND -> {
                if (intent.hasExtra(Intent.EXTRA_TEXT)) {
                    val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: ""
                    val url = extractUrl(text)
                    if (url != null) {
                        openUrlInPlayer(url)
                    } else if (text.isNotBlank()) {
                        openUrlInPlayer(text.trim())
                    }
                } else if (intent.hasExtra(Intent.EXTRA_STREAM)) {
                    val streamUri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                    } else {
                        @Suppress("DEPRECATION")
                        intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
                    }
                    if (streamUri != null) {
                        openUriInPlayer(streamUri)
                    }
                }
            }
        }
    }

    private fun extractUrl(text: String): String? {
        val pattern = Pattern.compile("https?://[^\\s]+")
        val matcher = pattern.matcher(text)
        return if (matcher.find()) matcher.group() else null
    }

    private fun openUriInPlayer(data: Uri) {
        try {
            contentResolver.takePersistableUriPermission(data, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: Exception) { }

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
        } catch (_: Exception) { }

        val mime = contentResolver.getType(data) ?: ""
        val isVideo = mime.startsWith("video") ||
            name.endsWith(".mp4", true) || name.endsWith(".mkv", true) ||
            name.endsWith(".webm", true) || name.endsWith(".mov", true) ||
            name.endsWith(".m4v", true) || name.endsWith(".avi", true)

        val o = JSONObject()
            .put("uri", "$ORIGIN$MEDIA_PREFIX" + Uri.encode(data.toString()))
            .put("cover", "$ORIGIN$THUMB_PREFIX" + Uri.encode(data.toString()))
            .put("name", name).put("title", "").put("artist", "").put("album", "")
            .put("size", size).put("mime", mime).put("duration", 0)
            .put("kind", if (isVideo) "video" else "audio")

        val js = "window.HashBridge && window.HashBridge.onOpenUri(${JSONObject.quote(o.toString())});"
        runJs(js)
    }

    private fun openUrlInPlayer(url: String) {
        val js = "window.HashBridge && window.HashBridge.onOpenUrl(${JSONObject.quote(url)});"
        runJs(js)
    }
}
