package com.mrghalibspcpu.hashplayer

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.util.Base64
import android.widget.RemoteViews
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/* ══════════════════════════════════════════════════════════════════
   HashPlayer's home-screen widget — the little one.

   What it carries:
     • a search bar — tap it and the app opens with the search box focused,
       ready for your library *and* YouTube results
     • the red ▶ inside that bar — straight into YouTube inside the app
     • a playlist shortcut
     • the file that played last: art, title, artist, plus a play button
       that resumes it from exactly where it stopped

   The player itself is the web app inside a WebView, so the widget never
   talks to it directly. [WidgetStore] is the meeting point: the shell writes
   "this is playing now" into SharedPreferences (with a thumbnail it decodes
   itself) and the widget reads that back whenever Android redraws it.
   ══════════════════════════════════════════════════════════════════ */
class HashWidget : AppWidgetProvider() {

    companion object {
        /* Taps that open the app; MainActivity routes them into the web UI. */
        const val ACTION_SEARCH = "hashplayer.widget.SEARCH"
        const val ACTION_YT = "hashplayer.widget.YT"
        const val ACTION_PLAYLISTS = "hashplayer.widget.PLAYLISTS"
        const val ACTION_RESUME = "hashplayer.widget.RESUME"

        /* Stays a broadcast: play/pause must not drag the app to the front. */
        const val ACTION_TOGGLE = "hashplayer.widget.TOGGLE"

        /** Redraw every instance of the widget from the stored state. */
        fun refresh(ctx: Context) {
            thread {
                try {
                    val mgr = AppWidgetManager.getInstance(ctx) ?: return@thread
                    val ids = mgr.getAppWidgetIds(ComponentName(ctx, HashWidget::class.java))
                    if (ids == null || ids.isEmpty()) return@thread
                    val rv = build(ctx)
                    mgr.updateAppWidget(ids, rv)
                } catch (e: Exception) { /* widget host gone — nothing to do */ }
            }
        }

        fun build(ctx: Context): RemoteViews {
            val rv = RemoteViews(ctx.packageName, R.layout.widget_hash)
            val st = WidgetStore.read(ctx)
            val d = ctx.resources.displayMetrics.density

            if (st.title.isBlank()) {
                rv.setTextViewText(R.id.w_title, ctx.getString(R.string.widget_idle_title))
                rv.setTextViewText(R.id.w_sub, ctx.getString(R.string.widget_idle_sub))
                rv.setImageViewResource(R.id.w_art, R.drawable.widget_art_ph)
            } else {
                rv.setTextViewText(R.id.w_title, st.title)
                rv.setTextViewText(
                    R.id.w_sub,
                    st.artist.ifBlank { ctx.getString(R.string.widget_last) }
                )
                val art = WidgetStore.readArt(ctx)
                if (art != null) rv.setImageViewBitmap(R.id.w_art, rounded(art, 13 * d))
                else rv.setImageViewResource(R.id.w_art, R.drawable.widget_art_ph)
            }

            rv.setImageViewResource(
                R.id.w_play,
                if (st.playing) R.drawable.ic_w_pause else R.drawable.ic_w_play
            )
            if (Build.VERSION.SDK_INT >= 26) {           // setContentDescription is API 26+
                rv.setContentDescription(
                    R.id.w_play,
                    ctx.getString(if (st.playing) R.string.widget_pause else R.string.widget_play)
                )
            }

            rv.setOnClickPendingIntent(R.id.w_search, open(ctx, ACTION_SEARCH, 11))
            rv.setOnClickPendingIntent(R.id.w_yt, open(ctx, ACTION_YT, 12))
            rv.setOnClickPendingIntent(R.id.w_playlists, open(ctx, ACTION_PLAYLISTS, 13))
            rv.setOnClickPendingIntent(R.id.w_now, open(ctx, ACTION_RESUME, 14))
            rv.setOnClickPendingIntent(R.id.w_title, open(ctx, ACTION_RESUME, 15))
            rv.setOnClickPendingIntent(R.id.w_play, broadcast(ctx, ACTION_TOGGLE, 16))
            return rv
        }

        private fun open(ctx: Context, action: String, code: Int): PendingIntent =
            PendingIntent.getActivity(
                ctx, code,
                Intent(ctx, MainActivity::class.java)
                    .setAction(action)
                    .addFlags(
                        Intent.FLAG_ACTIVITY_NEW_TASK or
                            Intent.FLAG_ACTIVITY_SINGLE_TOP or
                            Intent.FLAG_ACTIVITY_CLEAR_TOP
                    ),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

        private fun broadcast(ctx: Context, action: String, code: Int): PendingIntent =
            PendingIntent.getBroadcast(
                ctx, code,
                Intent(ctx, HashWidget::class.java).setAction(action),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

        /** Transparent corners, so the art matches the widget's rounded look. */
        private fun rounded(src: Bitmap, radius: Float): Bitmap {
            val out = Bitmap.createBitmap(src.width, src.height, Bitmap.Config.ARGB_8888)
            val c = Canvas(out)
            val p = Paint(Paint.ANTI_ALIAS_FLAG)
            val r = RectF(0f, 0f, src.width.toFloat(), src.height.toFloat())
            c.drawRoundRect(r, radius, radius, p)
            p.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
            c.drawBitmap(src, 0f, 0f, p)
            p.xfermode = null
            return out
        }
    }

    override fun onUpdate(
        context: Context,
        manager: AppWidgetManager,
        ids: IntArray
    ) {
        val rv = build(context)
        ids.forEach { id -> try { manager.updateAppWidget(id, rv) } catch (e: Exception) { } }
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION_TOGGLE) {
            /* The player is alive → toggle it in place, no window switch.
               It is not → open the app and let it resume the last file. */
            val t = PlaybackService.transport
            if (t != null) {
                try { t.invoke("toggle") } catch (e: Exception) { launch(context, ACTION_RESUME) }
            } else launch(context, ACTION_RESUME)
            return
        }
        super.onReceive(context, intent)
    }

    private fun launch(ctx: Context, action: String) {
        try {
            ctx.startActivity(
                Intent(ctx, MainActivity::class.java)
                    .setAction(action)
                    .addFlags(
                        Intent.FLAG_ACTIVITY_NEW_TASK or
                            Intent.FLAG_ACTIVITY_SINGLE_TOP or
                            Intent.FLAG_ACTIVITY_CLEAR_TOP
                    )
            )
        } catch (e: Exception) { }
    }
}

/* ══════════════════════════════════════════════════════════════════
   What the widget shows, and where its thumbnail comes from.
   ══════════════════════════════════════════════════════════════════ */
object WidgetStore {

    private const val PREFS = "hashplayer.widget"
    private const val ART_FILE = "widget_art.jpg"
    private const val MAX_ART = 192

    data class State(
        val title: String,
        val artist: String,
        val uri: String,
        val trackId: String,
        val kind: String,
        val playing: Boolean,
        val at: Long
    )

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun read(ctx: Context): State {
        val p = prefs(ctx)
        return State(
            title = p.getString("title", "").orEmpty(),
            artist = p.getString("artist", "").orEmpty(),
            uri = p.getString("uri", "").orEmpty(),
            trackId = p.getString("trackId", "").orEmpty(),
            kind = p.getString("kind", "audio").orEmpty(),
            playing = p.getBoolean("playing", false),
            at = p.getLong("at", 0L)
        )
    }

    /** Play/pause only — cheap, and it keeps the widget's button honest. */
    fun setPlaying(ctx: Context, playing: Boolean) {
        prefs(ctx).edit().putBoolean("playing", playing).apply()
        HashWidget.refresh(ctx)
    }

    /**
     * The web player reported what is on screen now. Called from the shell's
     * `setNowPlaying` bridge method every time a file starts, pauses or stops.
     */
    fun update(
        ctx: Context,
        title: String,
        artist: String,
        uri: String,
        trackId: String,
        kind: String,
        playing: Boolean,
        art: String
    ) {
        val app = ctx.applicationContext
        prefs(app).edit()
            .putString("title", title)
            .putString("artist", artist)
            .putString("uri", uri)
            .putString("trackId", trackId)
            .putString("kind", kind)
            .putBoolean("playing", playing)
            .putLong("at", System.currentTimeMillis())
            .apply()
        HashWidget.refresh(app)
        loadArt(app, art, uri, trackId)
    }

    /* ---------------------------------------------------------- artwork */

    private fun artFile(ctx: Context) = File(ctx.filesDir, ART_FILE)

    fun readArt(ctx: Context): Bitmap? {
        val f = artFile(ctx)
        if (!f.exists() || f.length() == 0L) return null
        return try { BitmapFactory.decodeFile(f.absolutePath) } catch (e: Throwable) { null }
    }

    private fun loadArt(ctx: Context, art: String, uri: String, trackId: String) {
        thread {
            try {
                val p = prefs(ctx)
                val key = trackId + "|" + uri
                val file = artFile(ctx)
                if (p.getString("artKey", null) == key && file.exists()) return@thread
                /* do not hammer a thumbnail that just refused to load */
                val tried = key + "|" + art
                if (p.getString("artTried", null) == tried &&
                    System.currentTimeMillis() - p.getLong("artTriedAt", 0L) < 300_000
                ) return@thread
                p.edit().putString("artTried", tried)
                    .putLong("artTriedAt", System.currentTimeMillis()).apply()

                val bmp = decodeDataUrl(art) ?: remote(art) ?: thumbOf(ctx, uri)
                if (bmp == null) { HashWidget.refresh(ctx); return@thread }

                val scale = minOf(1f, MAX_ART.toFloat() / maxOf(bmp.width, bmp.height))
                val out =
                    if (scale < 1f) Bitmap.createScaledBitmap(
                        bmp,
                        (bmp.width * scale).toInt().coerceAtLeast(1),
                        (bmp.height * scale).toInt().coerceAtLeast(1),
                        true
                    ) else bmp
                file.outputStream().use { out.compress(Bitmap.CompressFormat.JPEG, 88, it) }
                p.edit().putString("artKey", key).apply()
                HashWidget.refresh(ctx)
            } catch (e: Throwable) { /* a missing thumbnail is never fatal */ }
        }
    }

    private fun decodeDataUrl(s: String): Bitmap? {
        if (!s.startsWith("data:")) return null
        val i = s.indexOf("base64,")
        if (i < 0) return null
        return try {
            val bytes = Base64.decode(s.substring(i + 7), Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } catch (e: Throwable) { null }
    }

    /** YouTube thumbnails and any other http(s) artwork. */
    private fun remote(url: String): Bitmap? {
        if (!url.startsWith("http")) return null
        var conn: HttpURLConnection? = null
        return try {
            conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 8000
            conn.readTimeout = 8000
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13) HashPlayer/2.8")
            val bytes = conn.inputStream.use { it.readBytes() }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } catch (e: Throwable) {
            null
        } finally {
            try { conn?.disconnect() } catch (e: Exception) { }
        }
    }

    /**
     * Device files: MediaStore's own thumbnail, or the embedded cover / a video
     * frame through MediaMetadataRetriever. The uri arrives in the same
     * asset-loader shape the WebView uses, so unwrap it first.
     */
    private fun thumbOf(ctx: Context, uri: String): Bitmap? {
        val real = unwrap(uri)
        if (real.startsWith("http")) return remote(real)
        if (!real.startsWith("content://") && !real.startsWith("file://")) return null
        val u = try { Uri.parse(real) } catch (e: Exception) { return null }
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                return ctx.contentResolver.loadThumbnail(u, android.util.Size(MAX_ART, MAX_ART), null)
            } catch (e: Throwable) { }
        }
        val mmr = MediaMetadataRetriever()
        return try {
            mmr.setDataSource(ctx, u)
            val pic = mmr.embeddedPicture
            if (pic != null) BitmapFactory.decodeByteArray(pic, 0, pic.size)
            else mmr.getFrameAtTime(1_000_000)
        } catch (e: Throwable) {
            null
        } finally {
            try { mmr.release() } catch (e: Exception) { }
        }
    }

    /** `https://appassets…/media/<encoded content uri>` → the real uri. */
    private fun unwrap(s: String): String {
        val i = s.indexOf("/media/")
        return if (i >= 0) Uri.decode(s.substring(i + "/media/".length)) else s
    }
}
