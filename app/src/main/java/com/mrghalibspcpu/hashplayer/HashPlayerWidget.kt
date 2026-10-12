package com.mrghalibspcpu.hashplayer

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/**
 * Compact home-screen widget with dedicated transport controls.
 *
 * Every button now fires a specific PendingIntent directly at the service or
 * activity rather than wrapping the whole widget in a generic launcher tap,
 * so Play/Pause, Skip, Previous, EQ and ANC each execute their own action.
 */
class HashPlayerWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { manager.updateAppWidget(it, views(context)) }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        // Any widget button press refreshes the widget so the play/pause glyph stays honest.
        if (intent.action?.startsWith("com.mrghalibspcpu.hashplayer.widget.") == true) {
            refresh(context)
        }
    }

    companion object {
        const val ACTION_SEARCH      = "com.mrghalibspcpu.hashplayer.widget.SEARCH"
        const val ACTION_PLAYLISTS   = "com.mrghalibspcpu.hashplayer.widget.PLAYLISTS"
        const val ACTION_PLAY_LAST   = "com.mrghalibspcpu.hashplayer.widget.PLAY_LAST"
        const val ACTION_TOGGLE      = "com.mrghalibspcpu.hashplayer.widget.TOGGLE"
        const val ACTION_NEXT        = "com.mrghalibspcpu.hashplayer.widget.NEXT"
        const val ACTION_PREV        = "com.mrghalibspcpu.hashplayer.widget.PREV"
        const val ACTION_EQ          = "com.mrghalibspcpu.hashplayer.widget.EQ"
        const val ACTION_ANC         = "com.mrghalibspcpu.hashplayer.widget.ANC"

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

        fun setAnc(context: Context, on: Boolean) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean("anc_on", on).apply()
            refresh(context)
        }

        fun lastTrackId(context: Context): String = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_ID, "").orEmpty()

        private fun refresh(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val component = ComponentName(context, HashPlayerWidget::class.java)
            val ids = manager.getAppWidgetIds(component)
            ids.forEach { manager.updateAppWidget(it, views(context)) }
        }

        private fun views(context: Context): RemoteViews {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val title = prefs.getString(KEY_TITLE, null).orEmpty().ifBlank { "Nothing played yet" }
            val artist = prefs.getString(KEY_ARTIST, null).orEmpty().ifBlank { "Your last track will show here" }
            val id = prefs.getString(KEY_ID, "").orEmpty()
            val playing = prefs.getBoolean(KEY_PLAYING, false)
            return RemoteViews(context.packageName, R.layout.hashplayer_widget).apply {
                setTextViewText(R.id.widget_track_title, title)
                setTextViewText(R.id.widget_track_artist, artist)

                // Activity-launching actions (open a screen inside the app).
                setOnClickPendingIntent(R.id.widget_search,      activity(context, ACTION_SEARCH,    1))
                setOnClickPendingIntent(R.id.widget_playlists,   activity(context, ACTION_PLAYLISTS, 2))
                setOnClickPendingIntent(R.id.widget_track_preview, activity(context, ACTION_PLAY_LAST, 4))

                // Direct service actions — these never open the launcher activity.
                setOnClickPendingIntent(R.id.widget_play_last,   service(context, PlaybackService.ACTION_TOGGLE, 10))
                setOnClickPendingIntent(R.id.widget_prev,        service(context, PlaybackService.ACTION_PREV,   11))
                setOnClickPendingIntent(R.id.widget_next,        service(context, PlaybackService.ACTION_NEXT,   12))
                setOnClickPendingIntent(R.id.widget_eq,          activity(context, ACTION_EQ,       13))
                setOnClickPendingIntent(R.id.widget_anc,         service(context, PlaybackService.ACTION_TOGGLE_ANC, 14))

                // Flip the play/pause glyph so the widget reflects what is actually happening.
                setImageViewResource(
                    R.id.widget_play_last,
                    if (playing) R.drawable.widget_pause_icon else R.drawable.widget_play_icon
                )
                setFloat(R.id.widget_play_last, "setAlpha", if (id.isBlank()) 0.5f else 1f)
                // ANC pressed state — subtle alpha hint.
                setFloat(R.id.widget_anc, "setAlpha", if (prefs.getBoolean("anc_on", false)) 1f else 0.75f)
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

        /** Fire an action straight at the PlaybackService — no activity launch. */
        private fun service(context: Context, action: String, requestCode: Int): PendingIntent {
            val intent = Intent(context, PlaybackService::class.java).setAction(action)
            return PendingIntent.getService(
                context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (android.os.Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
            )
        }
    }
}
