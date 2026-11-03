package com.mrghalibspcpu.hashplayer

import android.content.Context
import android.util.AtomicFile
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.nio.charset.Charset
import java.util.concurrent.Executors

/**
 * Durable, native-side mirror of the web library's *metadata*.
 *
 * Favorites and playlists used to live only in WebView IndexedDB. If Android
 * evicted/recreated that storage (or the WebView origin was reset), the library
 * looked fine after a rescan but every favorite / playlist was gone.
 *
 * The web layer sends a small JSON snapshot here after structural changes.
 * Writes are atomic and revisioned; a stale snapshot can never overwrite a
 * newer one. Media blobs are never copied — device files are re-found by their
 * content:// URI, and artwork is re-extracted by the normal scan pipeline.
 */
class LibraryBackup(context: Context) {
    companion object { private const val TAG = "HashPlayerBackup" }

    private val file = AtomicFile(File(context.applicationContext.filesDir, "library-snapshot-v1.json"))
    private val io = Executors.newSingleThreadExecutor()
    private val lock = Any()
    @Volatile private var revision: Long = readRevision()

    fun read(): String = synchronized(lock) {
        try { String(file.readFully(), Charset.forName("UTF-8")) }
        catch (e: Exception) { "" }
    }

    /**
     * @param sync true only from pagehide / lifecycle flush, where we must hit
     *             disk before the process can be killed. Normal edits use the
     *             serial background executor so the UI thread never waits.
     */
    fun save(json: String, rev: Long, sync: Boolean): Boolean {
        if (rev <= revision) return true
        val write = Runnable {
            synchronized(lock) {
                if (rev > revision) {
                    var out = file.startWrite()
                    try {
                        out.write(json.toByteArray(Charset.forName("UTF-8")))
                        file.finishWrite(out)
                        revision = rev
                    } catch (e: Exception) {
                        file.failWrite(out)
                        Log.w(TAG, "library backup write", e)
                    }
                }
            }
        }
        return try {
            if (sync) write.run() else io.execute(write)
            true
        } catch (e: Exception) { Log.w(TAG, "library backup schedule", e); false }
    }

    fun clear() {
        synchronized(lock) {
            try { file.delete() } catch (e: Exception) { Log.w(TAG, "library backup clear", e) }
            revision = 0L
        }
    }

    private fun readRevision(): Long = try {
        JSONObject(read()).optLong("revision", 0L)
    } catch (e: Exception) { 0L }
}
