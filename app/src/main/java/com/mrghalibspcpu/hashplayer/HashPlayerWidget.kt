package com.mrghalibspcpu.hashplayer

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/** Compact home-screen shortcut with YouTube search and the last played item. */
class HashPlayerWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { manager.updateAppWidget(it, views(context)) }
    }

    companion object {
        const val ACTION_SEARCH = "com.mrghalibspcpu.hashplayer.widget.SEARCH"
        const val ACTION_PLAYLISTS = "com.mrghalibspcpu.hashplayer.widget.PLAYLISTS"
        const val ACTION_PLAY_LAST = "com.mrghalibspcpu.hashplayer.widget.PLAY_LAST"
        private const val PREFS = "hashplayer_widget"
        private const val KEY_TITLE = "last_title"
        private const val KEY_ARTIST = "last_artist"
        private const val KEY_ID = "last_id"

        fun saveNowPlaying(context: Context, title: String, artist: String, id: String) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_TITLE, title)
                .putString(KEY_ARTIST, artist)
                .putString(KEY_ID, id)
                .apply()
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
            return RemoteViews(context.packageName, R.layout.hashplayer_widget).apply {
                setTextViewText(R.id.widget_track_title, title)
                setTextViewText(R.id.widget_track_artist, artist)
                setOnClickPendingIntent(R.id.widget_search, activity(context, ACTION_SEARCH, 1))
                setOnClickPendingIntent(R.id.widget_playlists, activity(context, ACTION_PLAYLISTS, 2))
                setOnClickPendingIntent(R.id.widget_play_last, activity(context, ACTION_PLAY_LAST, 3))
                setOnClickPendingIntent(R.id.widget_track_preview, activity(context, ACTION_PLAY_LAST, 4))
                setFloat(R.id.widget_play_last, "setAlpha", if (id.isBlank()) 0.5f else 1f)
            }
        }

        private fun activity(context: Context, action: String, requestCode: Int): PendingIntent {
            val intent = Intent(context, MainActivity::class.java)
                .setAction(action)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            return PendingIntent.getActivity(
                context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (android.os.Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
            )
        }
    }
}
