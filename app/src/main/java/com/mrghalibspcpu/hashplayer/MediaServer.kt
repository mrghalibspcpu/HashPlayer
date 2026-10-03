package com.mrghalibspcpu.hashplayer

import android.content.ContentUris
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import android.util.Size
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A tiny loopback HTTP server that hands device media to the WebView.
 *
 * Why this exists: WebView's `shouldInterceptRequest` can feed a <video> tag, but the
 * Chromium media stack treats those responses as a single, non-resumable pipe. On a long
 * track it eventually stalls — the stream dies mid-song and the page only sees a generic
 * media error ("file unavailable, re-open it"). A real socket server speaks proper
 * HTTP/1.1 with byte ranges, so the media stack can reconnect, re-range and recover
 * exactly like it does with a file on a website. That is what makes playback behave
 * like a native player instead of giving up after a few minutes.
 *
 * It binds to 127.0.0.1 only (never reachable from outside the phone) on a random port,
 * and serves two things:
 *
 *   GET /media?u=<content uri>            seekable audio/video, full Range support
 *   GET /thumb?u=<content uri>&k=audio    album art / video poster frame (cached JPEG)
 */
class MediaServer(private val ctx: Context) {

    companion object {
        private const val TAG = "HashServer"
        private const val READ_BUF = 128 * 1024
    }

    @Volatile
    var port: Int = 0
        private set

    private val running = AtomicBoolean(false)
    private var server: ServerSocket? = null

    /* A connection must never wait for a free worker — a queued media request is a
       stalled song. Thumbnail *decoding* is the expensive part, so that (and only
       that) is throttled with a permit. */
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "hash-http").apply { isDaemon = true } }
    private val decoders = java.util.concurrent.Semaphore(2)
    private val noArt = java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<String, Boolean>())
    private val thumbDir: File by lazy { File(ctx.cacheDir, "thumbs").apply { mkdirs() } }

    /* ====================================================== lifecycle */

    fun start(): Int {
        if (running.get() && port > 0) return port
        return try {
            val s = ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"))
            s.reuseAddress = true
            server = s
            port = s.localPort
            running.set(true)
            Thread({ accept(s) }, "hash-http-accept").apply { isDaemon = true }.start()
            Log.i(TAG, "media server on 127.0.0.1:$port")
            port
        } catch (e: Exception) {
            Log.w(TAG, "could not start media server", e)
            port = 0
            0
        }
    }

    fun stop() {
        running.set(false)
        try { server?.close() } catch (e: Exception) { }
        server = null
        try { pool.shutdownNow() } catch (e: Exception) { }
    }

    private fun accept(s: ServerSocket) {
        while (running.get() && !s.isClosed) {
            try {
                val client = s.accept()
                pool.execute { serve(client) }
            } catch (e: Exception) {
                if (running.get()) Log.w(TAG, "accept", e)
            }
        }
    }

    /* ====================================================== url helpers */

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    fun mediaUrl(contentUri: String): String =
        if (port == 0) "" else "http://127.0.0.1:$port/media?u=${enc(contentUri)}"

    fun thumbUrl(contentUri: String, kind: String): String =
        if (port == 0) "" else "http://127.0.0.1:$port/thumb?u=${enc(contentUri)}&k=$kind"

    /* ====================================================== request handling */

    private fun serve(client: Socket) {
        try {
            client.soTimeout = 30000
            client.tcpNoDelay = true
            client.sendBufferSize = READ_BUF
            val input = client.getInputStream()
            val out = BufferedOutputStream(client.getOutputStream(), READ_BUF)

            val request = readRequest(input) ?: return
            val (method, target, headers) = request

            when {
                method == "OPTIONS" -> head(out, 204, "No Content", mapOf("Content-Length" to "0", "Allow" to "GET, HEAD, OPTIONS"))
                method != "GET" && method != "HEAD" -> text(out, 405, "Method Not Allowed", "no")
                target.startsWith("/media") -> media(method, target, headers, out)
                target.startsWith("/thumb") -> thumb(method, target, out)
                target.startsWith("/ping") -> text(out, 200, "OK", "pong")
                else -> text(out, 404, "Not Found", "no")
            }
            try { out.flush() } catch (e: Exception) { }
        } catch (e: Exception) {
            // Broken pipes are normal: the media stack closes a range the moment the user seeks.
        } finally {
            try { client.close() } catch (e: Exception) { }
        }
    }

    private data class Req(val method: String, val target: String, val headers: Map<String, String>)

    private fun readRequest(input: InputStream): Req? {
        val line = readLine(input) ?: return null
        val parts = line.split(' ')
        if (parts.size < 2) return null
        val headers = HashMap<String, String>()
        while (true) {
            val h = readLine(input) ?: break
            if (h.isEmpty()) break
            val i = h.indexOf(':')
            if (i > 0) headers[h.substring(0, i).trim().lowercase()] = h.substring(i + 1).trim()
        }
        return Req(parts[0].uppercase(), parts[1], headers)
    }

    private fun readLine(input: InputStream): String? {
        val buf = ByteArrayOutputStream(128)
        while (true) {
            val b = input.read()
            if (b < 0) return if (buf.size() == 0) null else buf.toString("UTF-8")
            if (b == '\n'.code) break
            if (b != '\r'.code) buf.write(b)
            if (buf.size() > 16384) return null
        }
        return buf.toString("UTF-8")
    }

    private fun query(target: String): Map<String, String> {
        val q = target.substringAfter('?', "")
        if (q.isEmpty()) return emptyMap()
        val m = HashMap<String, String>()
        q.split('&').forEach { kv ->
            val i = kv.indexOf('=')
            if (i > 0) {
                val k = kv.substring(0, i)
                val v = try { URLDecoder.decode(kv.substring(i + 1), "UTF-8") } catch (e: Exception) { "" }
                m[k] = v
            }
        }
        return m
    }

    /* ====================================================== responses */

    private fun head(
        out: OutputStream, code: Int, reason: String, extra: Map<String, String>
    ) {
        val sb = StringBuilder("HTTP/1.1 $code $reason\r\n")
        sb.append("Server: HashPlayer\r\n")
        sb.append("Access-Control-Allow-Origin: *\r\n")
        sb.append("Access-Control-Allow-Headers: Range\r\n")
        sb.append("Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Type\r\n")
        sb.append("Connection: close\r\n")
        extra.forEach { (k, v) -> sb.append(k).append(": ").append(v).append("\r\n") }
        sb.append("\r\n")
        out.write(sb.toString().toByteArray(Charsets.UTF_8))
    }

    private fun text(out: OutputStream, code: Int, reason: String, body: String) {
        val b = body.toByteArray(Charsets.UTF_8)
        head(out, code, reason, mapOf("Content-Type" to "text/plain; charset=utf-8", "Content-Length" to b.size.toString()))
        out.write(b)
    }

    /* ====================================================== /media */

    private fun media(method: String, target: String, headers: Map<String, String>, out: OutputStream) {
        val raw = query(target)["u"] ?: return text(out, 400, "Bad Request", "missing u")
        val uri = try { Uri.parse(raw) } catch (e: Exception) { null }
            ?: return text(out, 400, "Bad Request", "bad uri")

        val cr = ctx.contentResolver
        val mime = (try { cr.getType(uri) } catch (e: Exception) { null }) ?: guessMime(raw)

        val pfd = try { cr.openFileDescriptor(uri, "r") } catch (e: Exception) { null }
        if (pfd == null) {
            // Some providers refuse a descriptor but still stream; fall back to a plain stream.
            val s = try { cr.openInputStream(uri) } catch (e: Exception) { null }
                ?: return text(out, 404, "Not Found", "cannot open")
            head(out, 200, "OK", mapOf("Content-Type" to mime, "Accept-Ranges" to "none", "Cache-Control" to "no-store"))
            if (method != "HEAD") pump(s, out, -1)
            try { s.close() } catch (e: Exception) { }
            return
        }

        val total = pfd.statSize
        var start = 0L
        var end = if (total > 0) total - 1 else -1L
        var partial = false
        val range = headers["range"]
        if (range != null && range.startsWith("bytes=")) {
            val p = range.removePrefix("bytes=").split('-')
            val a = p.getOrNull(0)?.trim().orEmpty()
            val b = p.getOrNull(1)?.trim().orEmpty()
            if (a.isEmpty() && b.isNotEmpty()) {                 // suffix range: bytes=-500
                val n = b.toLongOrNull() ?: 0L
                if (total > 0) { start = (total - n).coerceAtLeast(0); end = total - 1 }
            } else {
                start = a.toLongOrNull() ?: 0L
                b.toLongOrNull()?.let { end = it }
            }
            partial = true
        }
        if (total > 0 && (end < 0 || end > total - 1)) end = total - 1
        if (start < 0) start = 0
        if (total > 0 && start >= total) {
            try { pfd.close() } catch (e: Exception) { }
            head(out, 416, "Range Not Satisfiable", mapOf("Content-Range" to "bytes */$total"))
            return
        }

        val length = if (total > 0) end - start + 1 else -1L
        val h = HashMap<String, String>()
        h["Content-Type"] = mime
        h["Accept-Ranges"] = "bytes"
        h["Cache-Control"] = "no-store"
        if (length >= 0) h["Content-Length"] = length.toString()
        if (partial && total > 0) h["Content-Range"] = "bytes $start-$end/$total"
        head(out, if (partial) 206 else 200, if (partial) "Partial Content" else "OK", h)

        if (method == "HEAD") { try { pfd.close() } catch (e: Exception) { }; return }

        val fis = android.os.ParcelFileDescriptor.AutoCloseInputStream(pfd)
        try {
            if (start > 0) {
                try { fis.channel.position(start) } catch (e: Exception) { skipFully(fis, start) }
            }
            pump(fis, out, length)
        } finally {
            try { fis.close() } catch (e: Exception) { }
        }
    }

    private fun pump(input: InputStream, out: OutputStream, limit: Long) {
        val buf = ByteArray(READ_BUF)
        var left = limit
        while (left != 0L) {
            val want = if (left < 0) buf.size else minOf(left, buf.size.toLong()).toInt()
            val n = input.read(buf, 0, want)
            if (n <= 0) break
            out.write(buf, 0, n)
            if (left > 0) left -= n
        }
        out.flush()
    }

    private fun skipFully(input: InputStream, bytes: Long) {
        var left = bytes
        while (left > 0) {
            val n = input.skip(left)
            if (n <= 0) { if (input.read() < 0) break else left-- } else left -= n
        }
    }

    /* ====================================================== /thumb */

    private fun thumb(method: String, target: String, out: OutputStream) {
        val q = query(target)
        val raw = q["u"] ?: return text(out, 400, "Bad Request", "missing u")
        val kind = q["k"] ?: "audio"
        val key = (raw + "|" + kind).hashCode().toString().replace('-', 'n')
        val cached = File(thumbDir, "$key.jpg")
        val blank = File(thumbDir, "$key.none")
        if (noArt.contains(key) || blank.exists()) { text(out, 404, "Not Found", "no art"); return }

        val bytes: ByteArray? = if (cached.exists() && cached.length() > 0) {
            try { cached.readBytes() } catch (e: Exception) { null }
        } else {
            var made: ByteArray? = null
            val got = try { decoders.tryAcquire(20, java.util.concurrent.TimeUnit.SECONDS) } catch (e: Exception) { false }
            if (got) {
                try { made = makeThumb(Uri.parse(raw), kind) } finally { decoders.release() }
            }
            if (made != null) { try { cached.writeBytes(made) } catch (e: Exception) { } }
            else if (got) {
                // Remember that this file simply has no artwork, so the grid stops asking.
                noArt.add(key); try { blank.createNewFile() } catch (e: Exception) { }
            }
            made
        }

        if (bytes == null || bytes.isEmpty()) { text(out, 404, "Not Found", "no art"); return }
        head(
            out, 200, "OK",
            mapOf(
                "Content-Type" to "image/jpeg",
                "Content-Length" to bytes.size.toString(),
                "Cache-Control" to "public, max-age=31536000, immutable"
            )
        )
        if (method != "HEAD") out.write(bytes)
    }

    /** Album art for a song, a poster frame for a video — whatever the OS can give us. */
    private fun makeThumb(uri: Uri, kind: String): ByteArray? {
        // 1. The modern, cheap path: MediaStore already keeps thumbnails for its own entries.
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                val bmp = ctx.contentResolver.loadThumbnail(uri, Size(512, 512), null)
                return jpeg(bmp)
            } catch (e: Throwable) { /* fall through */ }
        }

        // 2. Embedded cover art (ID3 / MP4) or a frame from the video.
        val mmr = MediaMetadataRetriever()
        try {
            mmr.setDataSource(ctx, uri)
            val pic = mmr.embeddedPicture
            if (pic != null && pic.isNotEmpty()) {
                val bmp = BitmapFactory.decodeByteArray(pic, 0, pic.size)
                if (bmp != null) return jpeg(scale(bmp, 512))
            }
            if (kind == "video") {
                val frame = mmr.getFrameAtTime(2_000_000L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                    ?: mmr.getFrameAtTime(0L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                if (frame != null) return jpeg(scale(frame, 512))
            }
        } catch (e: Throwable) {
            // some files simply have no art — that's fine
        } finally {
            try { mmr.release() } catch (e: Exception) { }
        }

        // 3. Legacy album-art table (pre-Q devices with no embedded picture).
        if (kind == "audio" && Build.VERSION.SDK_INT < 29) {
            try {
                val id = ContentUris.parseId(uri)
                val c = ctx.contentResolver.query(
                    MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                    arrayOf(MediaStore.Audio.Media.ALBUM_ID),
                    MediaStore.Audio.Media._ID + "=?", arrayOf(id.toString()), null
                )
                c?.use {
                    if (it.moveToFirst()) {
                        val albumId = it.getLong(0)
                        val art = ContentUris.withAppendedId(
                            Uri.parse("content://media/external/audio/albumart"), albumId
                        )
                        ctx.contentResolver.openInputStream(art)?.use { s ->
                            val bmp = BitmapFactory.decodeStream(s)
                            if (bmp != null) return jpeg(scale(bmp, 512))
                        }
                    }
                }
            } catch (e: Throwable) { }
        }
        return null
    }

    private fun scale(b: Bitmap, max: Int): Bitmap {
        val w = b.width; val h = b.height
        if (w <= max && h <= max) return b
        val r = if (w > h) max.toFloat() / w else max.toFloat() / h
        return try { Bitmap.createScaledBitmap(b, (w * r).toInt().coerceAtLeast(1), (h * r).toInt().coerceAtLeast(1), true) }
        catch (e: Throwable) { b }
    }

    private fun jpeg(b: Bitmap?): ByteArray? {
        b ?: return null
        val bos = ByteArrayOutputStream()
        return try {
            b.compress(Bitmap.CompressFormat.JPEG, 82, bos)
            bos.toByteArray()
        } catch (e: Throwable) { null }
    }

    private fun guessMime(s: String): String = when (s.substringAfterLast('.', "").lowercase()) {
        "mp3" -> "audio/mpeg"; "m4a", "aac" -> "audio/mp4"; "flac" -> "audio/flac"
        "wav" -> "audio/wav"; "ogg", "oga" -> "audio/ogg"; "opus" -> "audio/opus"
        "mp4", "m4v" -> "video/mp4"; "webm" -> "video/webm"; "mkv" -> "video/x-matroska"
        "3gp" -> "video/3gpp"; "mov" -> "video/quicktime"
        else -> "application/octet-stream"
    }
}
