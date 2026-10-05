package com.annan.asttube

import android.annotation.SuppressLint
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
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Keeps AST Tube playing when you leave the app or turn the screen off.
 *
 * The video itself keeps playing inside the WebView; this foreground service
 * just keeps the app process alive and shows the media notification / lock
 * screen controls. Button presses go back to the page as actions
 * ("play", "pause", "next", "prev", "seek:<sec>", "close") via [onAction].
 */
class MediaService : Service() {
    companion object {
        private const val CHANNEL = "playback"
        private const val NOTIFICATION_ID = 7
        private const val EXTRA_STATE = "state"

        /** Set by MainActivity; receives notification/headset button presses. */
        var onAction: ((String) -> Unit)? = null
        private var instance: MediaService? = null

        /** Shows or updates the notification. Call from the foreground first (Android limits background starts). */
        fun update(context: Context, state: JSONObject) {
            val running = instance
            if (running != null) running.apply(state)
            else ContextCompat.startForegroundService(context, Intent(context, MediaService::class.java).putExtra(EXTRA_STATE, state.toString()))
        }

        fun stop(context: Context) {
            instance?.let { it.stopForeground(STOP_FOREGROUND_REMOVE); it.stopSelf() }
            instance = null
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val http = OkHttpClient()
    private lateinit var session: MediaSessionCompat
    private var wifiLock: WifiManager.WifiLock? = null
    private var state = JSONObject()
    private var artUrl: String? = null
    private var art: Bitmap? = null
    private var foreground = false

    override fun onBind(intent: Intent?): IBinder? = null

    @SuppressLint("WifiManagerLeak")
    override fun onCreate() {
        super.onCreate()
        instance = this
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "Playback", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shows what's playing, with play/pause controls"
                    setShowBadge(false)
                })
        }
        session = MediaSessionCompat(this, "ASTTube").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = send("play")
                override fun onPause() = send("pause")
                override fun onSkipToNext() = send("next")
                override fun onSkipToPrevious() = send("prev")
                override fun onSeekTo(pos: Long) = send("seek:${pos / 1000}")
                override fun onStop() = send("close")
                override fun onCustomAction(action: String?, extras: android.os.Bundle?) { if (action == "close") send("close") }
            })
            isActive = true
        }
        // Keep Wi-Fi awake while streaming with the screen off.
        wifiLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
            .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "asttube:playback").apply { setReferenceCounted(false) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Notification buttons arrive as service intents named after the action.
        intent?.action?.takeIf { it in setOf("play", "pause", "next", "prev", "close") }?.let { send(it) }
        intent?.getStringExtra(EXTRA_STATE)?.let { apply(JSONObject(it)) }
        if (!foreground) apply(state) // must call startForeground promptly after startForegroundService
        return START_NOT_STICKY
    }

    private fun send(action: String) {
        main.post { onAction?.invoke(action) }
    }

    fun apply(s: JSONObject) {
        state = s
        val playing = s.optBoolean("playing")
        val duration = (s.optDouble("duration", 0.0) * 1000).toLong()
        val position = (s.optDouble("position", 0.0) * 1000).toLong()
        var actions = PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
            PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_STOP
        if (duration > 0) actions = actions or PlaybackStateCompat.ACTION_SEEK_TO
        if (s.optBoolean("hasNext")) actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_NEXT
        if (s.optBoolean("hasPrev")) actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
        session.setPlaybackState(PlaybackStateCompat.Builder()
            .setActions(actions)
            .addCustomAction("close", "Close", R.drawable.ic_close)
            .setState(if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED, position, if (playing) s.optDouble("rate", 1.0).toFloat() else 0f)
            .build())
        val url = s.optString("artwork").takeIf { it.isNotEmpty() }
        if (url != artUrl) {
            artUrl = url
            art = null
            if (url != null) io.execute {
                val bmp = try {
                    http.newCall(okhttp3.Request.Builder().url(url).build()).execute().use { BitmapFactory.decodeStream(it.body?.byteStream()) }
                } catch (e: Exception) { null }
                main.post { if (artUrl == url) { art = bmp; publish() } }
            }
        }
        if (playing) wifiLock?.acquire() else wifiLock?.release()
        publish()
    }

    private fun publish() {
        val s = state
        session.setMetadata(MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, s.optString("title"))
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, s.optString("artist"))
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, (s.optDouble("duration", 0.0) * 1000).toLong())
            .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art)
            .build())
        val notification = build(s)
        if (!foreground) {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            else startForeground(NOTIFICATION_ID, notification)
            foreground = true
        } else {
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification)
        }
    }

    private fun build(s: JSONObject): Notification {
        val playing = s.optBoolean("playing")
        val open = PendingIntent.getActivity(this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        fun action(icon: Int, title: String, name: String) = NotificationCompat.Action(icon, title,
            PendingIntent.getService(this, name.hashCode(), Intent(this, MediaService::class.java).setAction(name), PendingIntent.FLAG_IMMUTABLE))
        val b = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(s.optString("title"))
            .setContentText(s.optString("artist"))
            .setLargeIcon(art)
            .setContentIntent(open)
            .setOngoing(playing)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .addAction(action(R.drawable.ic_prev, "Previous", "prev"))
            .addAction(if (playing) action(R.drawable.ic_pause, "Pause", "pause") else action(R.drawable.ic_play, "Play", "play"))
            .addAction(action(R.drawable.ic_next, "Next", "next"))
            .addAction(action(R.drawable.ic_close, "Close", "close"))
            .setStyle(androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(session.sessionToken)
                .setShowActionsInCompactView(0, 1, 2))
        return b.build()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // App swiped away from recents: stop playing.
        send("close")
        stop(this)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        wifiLock?.release()
        session.isActive = false
        session.release()
        io.shutdownNow()
        if (instance === this) instance = null
        super.onDestroy()
    }
}
