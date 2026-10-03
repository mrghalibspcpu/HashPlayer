package com.mrghalibspcpu.hashplayer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Keeps HashPlayer audible when the app is in the background and puts a proper
 * media notification (with lock-screen controls) on screen. The actual audio is
 * produced by the WebView, so this service only owns the MediaSession, the
 * notification and the "don't kill me" foreground state.
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

        fun update(ctx: Context, playing: Boolean, title: String, artist: String) {
            if (!playing && !running) return
            val i = Intent(ctx, PlaybackService::class.java)
                .putExtra("playing", playing)
                .putExtra("title", title)
                .putExtra("artist", artist)
            try {
                if (playing) {
                    if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
                } else ctx.startService(i)
            } catch (e: Exception) { /* background start limits — ignore */ }
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
    private var wake: android.os.PowerManager.WakeLock? = null
    private var wifi: android.net.wifi.WifiManager.WifiLock? = null
    private var focusLost = false
    private var audio: android.media.AudioManager? = null
    @Suppress("DEPRECATION")
    private var focusRequest: Any? = null

    /* --------------------------------------------------------------
       Wake locks. Android aggressively idles the CPU (and the Wi-Fi
       radio for streams) a couple of minutes after the screen goes
       off; when the player lives inside a WebView that shows up as
       playback simply stopping mid-track. Holding a partial lock while
       we are the active media app is exactly what a native player does.
       -------------------------------------------------------------- */
    private fun holdLocks(on: Boolean) {
        try {
            if (on) {
                if (wake == null) {
                    val pm = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
                    wake = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "hashplayer:playback")
                        .apply { setReferenceCounted(false) }
                }
                if (wake?.isHeld != true) wake?.acquire(4 * 60 * 60 * 1000L)
                if (wifi == null) {
                    val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as android.net.wifi.WifiManager
                    wifi = wm.createWifiLock(android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "hashplayer:net")
                        .apply { setReferenceCounted(false) }
                }
                if (wifi?.isHeld != true) wifi?.acquire()
            } else {
                if (wake?.isHeld == true) wake?.release()
                if (wifi?.isHeld == true) wifi?.release()
            }
        } catch (e: Exception) { /* locks are a nicety, never a crash */ }
    }

    /* Play nicely with calls, alarms and other players. */
    private val focusListener = android.media.AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            android.media.AudioManager.AUDIOFOCUS_LOSS -> { focusLost = false; transport?.invoke("pause") }
            android.media.AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                if (playing) { focusLost = true; transport?.invoke("pause") }
            }
            android.media.AudioManager.AUDIOFOCUS_GAIN -> {
                if (focusLost) { focusLost = false; transport?.invoke("play") }
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun focus(on: Boolean) {
        try {
            val am = audio ?: (getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager).also { audio = it }
            if (Build.VERSION.SDK_INT >= 26) {
                if (on) {
                    val attrs = android.media.AudioAttributes.Builder()
                        .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build()
                    val r = android.media.AudioFocusRequest.Builder(android.media.AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(attrs)
                        .setOnAudioFocusChangeListener(focusListener)
                        .setWillPauseWhenDucked(false)
                        .build()
                    focusRequest = r
                    am.requestAudioFocus(r)
                } else (focusRequest as? android.media.AudioFocusRequest)?.let { am.abandonAudioFocusRequest(it) }
            } else {
                if (on) am.requestAudioFocus(
                    focusListener, android.media.AudioManager.STREAM_MUSIC,
                    android.media.AudioManager.AUDIOFOCUS_GAIN
                ) else am.abandonAudioFocus(focusListener)
            }
        } catch (e: Exception) { }
    }

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
        artist = intent?.getStringExtra("artist") ?: ""

        session?.apply {
            setMetadata(
                MediaMetadataCompat.Builder()
                    .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                    .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
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

        holdLocks(playing)
        focus(playing)

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
        running = false
        holdLocks(false)
        focus(false)
        session?.isActive = false
        session?.release()
        session = null
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }
}
