package com.mrghalibspcpu.hashplayer

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.RemoteViews

/**
 * Home-screen widget with dedicated, working transport controls.
 *
 * The microphone-looking ANC button has been removed from the widget (ANC is
 * still available inside the player). Search, Playlists, Prev, EQ, Play/Pause
 * and Next each own a distinct PendingIntent. Transport taps are broadcasts to
 * this receiver, which is allowed from the background; if the player process is
 * dead we open MainActivity and replay the command once the web library is ready.
 *
 * Resize: the launcher tells us the available size through AppWidget options.
 * Short/narrow placements switch to a compact control-only layout so buttons
 * are never clipped; larger placements get the flexible last-track preview.
 */
class HashPlayerWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { manager.updateAppWidget(it, views(context, manager.getAppWidgetOptions(it))) }
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            refresh(context)
            return
        }
        val action = intent.action
        // Resize / orientation option changes arrive as a broadcast on every
        // supported Android version (the AppWidgetProvider callback is newer
        // and not present in all compile SDKs).
        if (action == AppWidgetManager.ACTION_APPWIDGET_OPTIONS_CHANGED) {
            val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            if (id != AppWidgetManager.INVALID_APPWIDGET_ID) {
                val opts = intent.getBundleExtra(AppWidgetManager.EXTRA_APPWIDGET_OPTIONS)
                AppWidgetManager.getInstance(context).updateAppWidget(id, views(context, opts))
            }
            return
        }
        super.onReceive(context, intent)
        when (action) {
            ACTION_TOGGLE -> transport(context, "toggle", ACTION_TOGGLE)
            ACTION_NEXT   -> transport(context, "next",   ACTION_NEXT)
            ACTION_PREV   -> transport(context, "prev",   ACTION_PREV)
        }
        if (action?.startsWith(PREFIX) == true) refresh(context)
    }

    companion object {
        const val ACTION_SEARCH      = "com.mrghalibspcpu.hashplayer.widget.SEARCH"
        const val ACTION_PLAYLISTS   = "com.mrghalibspcpu.hashplayer.widget.PLAYLISTS"
        const val ACTION_PLAY_LAST   = "com.mrghalibspcpu.hashplayer.widget.PLAY_LAST"
        const val ACTION_TOGGLE      = "com.mrghalibspcpu.hashplayer.widget.TOGGLE"
        const val ACTION_NEXT        = "com.mrghalibspcpu.hashplayer.widget.NEXT"
        const val ACTION_PREV        = "com.mrghalibspcpu.hashplayer.widget.PREV"
        const val ACTION_EQ          = "com.mrghalibspcpu.hashplayer.widget.EQ"

        private const val PREFIX = "com.mrghalibspcpu.hashplayer.widget."
        private const val PREFS = "hashplayer_widget"
        private const val KEY_TITLE = "last_title"
        private const val KEY_ARTIST = "last_artist"
        private const val KEY_ID = "last_id"
        private const val KEY_PLAYING = "is_playing"

        fun saveNowPlaying(context: Context, title: String, artist: String, id: String) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_TITLE, title)
                .putString(KEY_ARTIST, artist)
                .putString(KEY_ID, id)
                .apply()
            refresh(context)
        }

        fun setPlaying(context: Context, playing: Boolean) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean(KEY_PLAYING, playing).apply()
            refresh(context)
        }

        /** Kept so the in-app ANC toggle can still persist its state; the widget
         *  itself no longer renders a mic/ANC button. */
        fun setAnc(context: Context, on: Boolean) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean("anc_on", on).apply()
        }

        fun lastTrackId(context: Context): String = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_ID, "").orEmpty()

        private fun refresh(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val component = ComponentName(context, HashPlayerWidget::class.java)
            manager.getAppWidgetIds(component).forEach {
                manager.updateAppWidget(it, views(context, manager.getAppWidgetOptions(it)))
            }
        }

        fun forceRefresh(context: Context) { refresh(context) }

        private fun compact(opts: Bundle?): Boolean {
            if (opts == null) return false
            val h = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT,
                opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 160))
            val w = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH,
                opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 260))
            return (h in 1..124) || (w in 1..229)
        }

        private fun views(context: Context, opts: Bundle?): RemoteViews {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val id = prefs.getString(KEY_ID, "").orEmpty()
            val playing = prefs.getBoolean(KEY_PLAYING, false)
            val small = compact(opts)
            val layout = if (small) R.layout.hashplayer_widget_compact else R.layout.hashplayer_widget
            return RemoteViews(context.packageName, layout).apply {
                setOnClickPendingIntent(R.id.widget_search,      activity(context, ACTION_SEARCH,    1))
                setOnClickPendingIntent(R.id.widget_playlists,   activity(context, ACTION_PLAYLISTS, 2))
                setOnClickPendingIntent(R.id.widget_play_last,   broadcast(context, ACTION_TOGGLE, 10))
                setOnClickPendingIntent(R.id.widget_prev,        broadcast(context, ACTION_PREV,   11))
                setOnClickPendingIntent(R.id.widget_next,        broadcast(context, ACTION_NEXT,   12))
                setOnClickPendingIntent(R.id.widget_eq,          activity(context, ACTION_EQ,      13))

                setImageViewResource(
                    R.id.widget_play_last,
                    if (playing) R.drawable.widget_pause_icon else R.drawable.widget_play_icon
                )
                setFloat(R.id.widget_play_last, "setAlpha", if (id.isBlank()) 0.5f else 1f)

                if (!small) {
                    val title = prefs.getString(KEY_TITLE, null).orEmpty().ifBlank { context.getString(R.string.nothing_playing) }
                    val artist = prefs.getString(KEY_ARTIST, null).orEmpty().ifBlank { context.getString(R.string.widget_last_hint) }
                    setTextViewText(R.id.widget_track_title, title)
                    setTextViewText(R.id.widget_track_artist, artist)
                    setOnClickPendingIntent(R.id.widget_track_preview, activity(context, ACTION_PLAY_LAST, 4))
                }
            }
        }

        private fun activity(context: Context, action: String, requestCode: Int): PendingIntent {
            val intent = Intent(context, MainActivity::class.java)
                .setAction(action)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
            return PendingIntent.getActivity(
                context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (android.os.Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
            )
        }

        private fun broadcast(context: Context, action: String, requestCode: Int): PendingIntent {
            val intent = Intent(context, HashPlayerWidget::class.java).setAction(action)
            return PendingIntent.getBroadcast(
                context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (android.os.Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
            )
        }

        private fun transport(context: Context, command: String, replay: String) {
            val handler = PlaybackService.transport
            if (handler != null) {
                try { handler(command); return } catch (e: Exception) { /* fall through */ }
            }
            openApp(context, replay)
        }

        private fun openApp(context: Context, action: String) {
            try {
                context.startActivity(
                    Intent(context, MainActivity::class.java)
                        .setAction(action)
                        .addFlags(
                            Intent.FLAG_ACTIVITY_NEW_TASK or
                                Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                        )
                )
            } catch (e: Exception) { /* no activity to open */ }
        }
    }
}
