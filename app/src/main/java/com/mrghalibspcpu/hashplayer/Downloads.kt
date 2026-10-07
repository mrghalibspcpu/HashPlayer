package com.mrghalibspcpu.hashplayer

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Offline downloads.
 *
 * YouTube hands out separate video-only and audio-only streams for the high
 * resolutions, and muxing them into one file would need a full transcoder
 * inside the app. So a download takes the best *progressive* stream — one file
 * that already has picture and sound — and writes it straight into the phone's
 * Movies/HashPlayer folder through MediaStore, which needs no storage
 * permission on modern Android and makes the file visible to the gallery too.
 *
 * Nothing is re-encoded and nothing is uploaded: it is a plain HTTP copy of the
 * same stream the player would have streamed, and when it finishes the file is
 * added to the library as a normal local video that plays with no internet.
 */
object Downloads {

    private const val TAG = "HashPlayerDL"

    /** videoId → true while a download for it is running. */
    private val running = HashSet<String>()

    @Synchronized
    private fun claim(id: String): Boolean = running.add(id)

    @Synchronized
    private fun release(id: String) { running.remove(id) }

    /**
     * Download [videoId] in the background. [report] is called with JSON
     * progress events: `{id,state,pct,name,uri,kind,error}` where state is one
     * of `start | progress | done | error`.
     */
    fun start(ctx: Context, videoId: String, title: String, report: (String) -> Unit) {
        if (!claim(videoId)) {
            report(event(videoId, "error").put("error", "already downloading").toString())
            return
        }
        thread(name = "hp-download") {
            try { run(ctx, videoId, title, report) } catch (e: Throwable) {
                Log.w(TAG, "download failed", e)
                report(event(videoId, "error").put("error", e.message ?: "failed").toString())
            } finally { release(videoId) }
        }
    }

    private fun event(id: String, state: String) =
        JSONObject().put("id", id).put("state", state)

    private fun run(ctx: Context, videoId: String, titleIn: String, report: (String) -> Unit) {
        report(event(videoId, "start").put("pct", 0).toString())

        val r = YouTubeStream.resolve(videoId)
            ?: throw IllegalStateException("YouTube did not hand out a stream")
        if (r.isLive) throw IllegalStateException("live streams cannot be saved")

        val stream = r.muxed ?: r.audio
            ?: throw IllegalStateException("no downloadable stream")
        val isVideo = r.muxed != null
        val title = (titleIn.ifBlank { r.title }).ifBlank { "YouTube $videoId" }
        val ext = if (isVideo) "mp4" else "m4a"
        val name = safeName(title) + " [" + videoId + "]." + ext
        val mime = if (isVideo) "video/mp4" else "audio/mp4"

        val sink = openSink(ctx, name, mime, isVideo)
        var total = stream.contentLength
        var written = 0L
        var lastPct = -1

        try {
            val conn = (URL(stream.url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 20_000
                readTimeout = 30_000
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", r.userAgent)
                setRequestProperty("Origin", "https://www.youtube.com")
                setRequestProperty("Referer", "https://www.youtube.com/")
            }
            if (conn.responseCode !in 200..299)
                throw IllegalStateException("server said ${conn.responseCode}")
            if (total <= 0) total = conn.contentLengthLong

            conn.inputStream.use { input ->
                sink.out.use { out ->
                    val buf = ByteArray(128 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        written += n
                        if (total > 0) {
                            val pct = ((written * 100) / total).toInt().coerceIn(0, 99)
                            if (pct != lastPct) {
                                lastPct = pct
                                report(event(videoId, "progress").put("pct", pct).toString())
                            }
                        }
                    }
                }
            }
            conn.disconnect()
        } catch (e: Throwable) {
            sink.abort(ctx)
            throw e
        }

        sink.finish(ctx)

        report(
            event(videoId, "done")
                .put("pct", 100)
                .put("name", name)
                .put("title", title)
                .put("artist", r.author)
                .put("size", written)
                .put("mime", mime)
                .put("kind", if (isVideo) "video" else "audio")
                .put("duration", r.durationMs)
                .put("uri", MainActivity.ORIGIN + "/media/" + Uri.encode(sink.uri.toString()))
                .put("videoOnly", !isVideo)
                .toString()
        )
    }

    /* ---------------------------------------------------------------- sink */

    private class Sink(val uri: Uri, val out: OutputStream, val pending: Boolean) {
        fun finish(ctx: Context) {
            if (!pending || Build.VERSION.SDK_INT < 29) return
            val cv = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            try { ctx.contentResolver.update(uri, cv, null, null) } catch (e: Exception) { }
        }
        fun abort(ctx: Context) {
            try { out.close() } catch (e: Exception) { }
            try {
                if (pending) ctx.contentResolver.delete(uri, null, null)
                else if (uri.scheme == "file") File(uri.path!!).delete()
            } catch (e: Exception) { }
        }
    }

    private fun openSink(ctx: Context, name: String, mime: String, isVideo: Boolean): Sink {
        if (Build.VERSION.SDK_INT >= 29) {
            val collection = if (isVideo)
                MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            else MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            val dir = (if (isVideo) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_MUSIC) + "/HashPlayer"
            val cv = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, dir)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = ctx.contentResolver.insert(collection, cv)
                ?: throw IllegalStateException("could not create the file")
            val out = ctx.contentResolver.openOutputStream(uri)
                ?: throw IllegalStateException("could not write the file")
            return Sink(uri, out, true)
        }

        /* Android 6–9: the app's own external folder needs no permission and is
           still a real file on the SD card / internal storage. */
        val base = ctx.getExternalFilesDir(
            if (isVideo) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_MUSIC
        ) ?: ctx.filesDir
        val dir = File(base, "HashPlayer").apply { mkdirs() }
        val file = File(dir, name)
        return Sink(Uri.fromFile(file), FileOutputStream(file), false)
    }

    private fun safeName(s: String): String =
        s.replace(Regex("""[\\/:*?"<>|\n\r\t]"""), " ")
            .replace(Regex("""\s+"""), " ")
            .trim()
            .take(80)
            .ifBlank { "YouTube video" }
}
