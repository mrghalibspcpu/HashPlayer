package com.mrghalibspcpu.hashplayer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Keeps HashPlayer audible when the app is in the background and puts a proper
 * media notification (with lock-screen controls) on screen. The actual audio is
 * produced by the WebView, so this service owns the MediaSession, the
 * notification, the "don't kill me" foreground state — and a partial wake lock,
 * because without one Android puts the CPU to sleep a few minutes after the
 * screen goes dark and the music just stops mid-song.
 */
class PlaybackService : Service() {

    companion object {
        private const val CHANNEL = "hashplayer.playback"
        private const val NOTIF_ID = 1337
        const val ACTION_TOGGLE = "hashplayer.toggle"
        const val ACTION_NEXT = "hashplayer.next"
        const val ACTION_PREV = "hashplayer.prev"
        const val ACTION_STOP = "hashplayer.stop"

        @Volatile var running = false

        /** Set by MainActivity: forwards notification / lock-screen taps into the web app. */
        var transport: ((String) -> Unit)? = null

        /** Cover that arrived before the service was running — attached on the next update(). */
        @Volatile private var pendingArt: String? = null

        fun update(ctx: Context, playing: Boolean, title: String, artist: String) {
            if (!playing && !running) return
            val i = Intent(ctx, PlaybackService::class.java)
                .putExtra("playing", playing)
                .putExtra("title", title)
                .putExtra("artist", artist)
            pendingArt?.let { p -> i.putExtra("art", p) }
            try {
                if (playing) {
                    if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
                } else ctx.startService(i)
            } catch (e: Exception) { /* background start limits — ignore */ }
        }

        /** Cover art for the notification (base64 JPEG, already downscaled by the web side). */
        fun setArt(ctx: Context, b64: String) {
            pendingArt = b64
            if (!running) return            // it will ride along with the next update()
            try { ctx.startService(Intent(ctx, PlaybackService::class.java).putExtra("art", b64)) } catch (e: Exception) { }
        }

        fun stop(ctx: Context) {
            if (!running) return
            try { ctx.stopService(Intent(ctx, PlaybackService::class.java)) } catch (e: Exception) { }
        }
    }

    private var session: MediaSessionCompat? = null
    private var title = ""
    private var artist = ""
    private var playing = false
    private var art: Bitmap? = null
    private var artB64: String? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        session = MediaSessionCompat(this, "HashPlayer").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() { transport?.invoke("play") }
                override fun onPause() { transport?.invoke("pause") }
                override fun onSkipToNext() { transport?.invoke("next") }
                override fun onSkipToPrevious() { transport?.invoke("prev") }
                override fun onStop() { transport?.invoke("pause") }
            })
            isActive = true
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_TOGGLE -> { transport?.invoke("toggle"); return START_STICKY }
            ACTION_NEXT -> { transport?.invoke("next"); return START_STICKY }
            ACTION_PREV -> { transport?.invoke("prev"); return START_STICKY }
            ACTION_STOP -> { transport?.invoke("pause"); stopSelf(); return START_NOT_STICKY }
        }

        playing = intent?.getBooleanExtra("playing", playing) ?: playing
        title = intent?.getStringExtra("title")?.ifBlank { getString(R.string.nothing_playing) }
            ?: getString(R.string.nothing_playing)
        artist = intent?.getStringExtra("artist") ?: artist

        /* a cover arrived (possibly on its own, after the track already started) */
        intent?.getStringExtra("art")?.let { b64 ->
            if (b64 != artB64) { artB64 = b64; art = decodeArt(b64) }
        }

        session?.apply {
            setMetadata(
                MediaMetadataCompat.Builder()
                    .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                    .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
                    .apply {
                        art?.let {
                            putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it)
                            putBitmap(MediaMetadataCompat.METADATA_KEY_ART, it)
                        }
                    }
                    .build()
            )
            setPlaybackState(
                PlaybackStateCompat.Builder()
                    .setActions(
                        PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
                            PlaybackStateCompat.ACTION_PLAY_PAUSE or
                            PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                            PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                            PlaybackStateCompat.ACTION_STOP
                    )
                    .setState(
                        if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
                        PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1f
                    ).build()
            )
        }

        /* the CPU must stay awake while the WebView is producing audio — this is
           what stops "it plays for a while and then goes silent" with the screen off */
        holdAwake(playing)

        val notif = build()
        try {
            ServiceCompat.startForeground(
                this, NOTIF_ID, notif,
                if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0
            )
            running = true
        } catch (e: Exception) {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(NOTIF_ID, notif)
        }
        return START_STICKY
    }

    private fun holdAwake(on: Boolean) {
        try {
            if (on) {
                if (wakeLock == null) {
                    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "HashPlayer:playback")
                }
                wakeLock?.let { if (!it.isHeld) it.acquire() }
            } else {
                wakeLock?.let { if (it.isHeld) it.release() }
            }
        } catch (e: Exception) { }
    }

    private fun decodeArt(b64: String): Bitmap? = try {
        val bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) null
        else {
            val opts = BitmapFactory.Options().apply {
                inSampleSize = maxOf(1, maxOf(bounds.outWidth, bounds.outHeight) / 512)
            }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
        }
    } catch (e: Exception) { null }

    private fun action(name: String) = PendingIntent.getService(
        this, name.hashCode(),
        Intent(this, PlaybackService::class.java).setAction(name),
        PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
    )

    private fun build(): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_hash)
            .setContentTitle(title)
            .setContentText(artist)
            .setContentIntent(open)
            .setLargeIcon(art)
            .setDeleteIntent(action(ACTION_STOP))
            .addAction(android.R.drawable.ic_media_previous, "Previous", action(ACTION_PREV))
            .addAction(
                if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (playing) "Pause" else "Play", action(ACTION_TOGGLE)
            )
            .addAction(android.R.drawable.ic_media_next, "Next", action(ACTION_NEXT))
            .setStyle(
                androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(session?.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(playing)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL) != null) return
        val ch = NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW)
        ch.description = getString(R.string.channel_desc)
        ch.setShowBadge(false)
        ch.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        nm.createNotificationChannel(ch)
    }

    override fun onDestroy() {
        holdAwake(false)
        wakeLock = null
        running = false
        session?.isActive = false
        session?.release()
        session = null
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        holdAwake(false)
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }
}
