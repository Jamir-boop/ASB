package local.asb.companion.notify

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import local.asb.companion.AsbApp
import local.asb.companion.MainActivity
import local.asb.companion.R
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Thread
import local.asb.companion.net.AsbApi
import local.asb.companion.net.AsbError
import local.asb.companion.net.DashboardResult
import local.asb.companion.ui.idleAge

/** The last dashboard rows that the screen or the live service read, and when. */
data class LiveUpdate(val threads: List<Thread>, val atMs: Long)

private const val LIVE_CHANNEL = "asb_live"
private const val LIVE_ID = 1
private const val ACTION_STOP = "local.asb.companion.STOP_LIVE"
private const val MAX_LINES = 6

internal fun liveTitle(threads: List<Thread>): String {
    val rows = threads.filter { !it.archived }
    val sessions = if (rows.size == 1) "1 session" else "${rows.size} sessions"
    return "$sessions · ${rows.count { it.state == "working" }} working · ${rows.count { it.pending }} pending"
}

internal fun liveLines(threads: List<Thread>): List<String> {
    val titles = threads.filter { !it.archived && it.state == "working" }
        .map { it.title.ifBlank { it.projectName }.ifBlank { "Untitled session" } }
    if (titles.isEmpty()) return listOf("No session is working.")
    return if (titles.size <= MAX_LINES) titles else titles.take(MAX_LINES) + "+${titles.size - MAX_LINES} more"
}

// Offline retries stay slow: each try can wait for every endpoint to time out.
internal fun liveIntervalMs(threads: List<Thread>?, offline: Boolean): Long =
    if (!offline && threads.orEmpty().any { !it.archived && it.state == "working" }) 5_000L else 30_000L

internal fun liveOfflineText(lastMs: Long, nowMs: Long): String =
    if (lastMs <= 0) "Offline"
    else "Offline · last update " + idleAge(lastMs, nowMs).replaceFirstChar { it.lowercaseChar() }

/**
 * Shows the session counts in an ongoing notification. While the session screen polls, this service only
 * shows its dashboards; otherwise the service polls, and in the background it also posts the attention alerts.
 */
class LiveService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var loop: Job? = null
    private var last: LiveUpdate? = null
    private var own: LiveUpdate? = null // the last update that this service wrote
    private var offline = false
    private var shown: Triple<String, List<String>, String?>? = null

    companion object {
        /**
         * Starts the service when the pairing is current, the switch is on, and ASB can post notifications;
         * a refused start leaves CheckWorker. onResume starts it again after the user allows notifications.
         */
        fun startIfEnabled(context: Context) {
            val store = (context.applicationContext as AsbApp).store
            if (!store.paired || store.revoked || !store.liveNotification || !Notifier.notificationsAllowed(context)) return
            try {
                ContextCompat.startForegroundService(context, Intent(context, LiveService::class.java))
            } catch (_: IllegalStateException) {
                // ForegroundServiceStartNotAllowedException: Android refused a start from the background.
            } catch (_: SecurityException) {
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, LiveService::class.java))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = application as AsbApp
        if (intent?.action == ACTION_STOP) {
            app.useLiveNotification(false)
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            val content = content()
            val notification = build(content)
            if (Build.VERSION.SDK_INT >= 34) startForeground(LIVE_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            else startForeground(LIVE_ID, notification)
            shown = content
        } catch (_: IllegalStateException) {
            stopSelf()
            return START_NOT_STICKY
        } catch (_: SecurityException) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (loop == null) loop = scope.launch {
            launch {
                app.liveUpdates.collect { update ->
                    if (update == null) return@collect
                    last = update
                    offline = false
                    show()
                }
            }
            run(app)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        getSystemService(NotificationManager::class.java).cancel(LIVE_ID)
        super.onDestroy()
    }

    private suspend fun run(app: AsbApp) {
        var api: AsbApi? = null
        var apiToken = ""
        var etag: String? = null
        while (scope.isActive) {
            val token = synchronized(app.store) {
                if (!app.store.paired || app.store.revoked || !app.store.liveNotification) null else app.store.token
            }
            if (token == null) { stopSelf(); return }
            val fed = app.liveUpdates.value
            // Only the session screen feeds updates; on Settings or Connection the service reads itself.
            if (app.resumed && fed != null && fed !== own && System.currentTimeMillis() - fed.atMs < 10_000) {
                // The screen polls now; its baseline can be newer, so the next own read is a full one.
                etag = null
                delay(1000)
                continue
            }
            // A hidden notification posts no alerts, so the service stops; onResume starts it again.
            if (!Notifier.notificationsAllowed(app)) { stopSelf(); return }
            if (api == null || apiToken != token) { api = app.api(); apiToken = token; etag = null }
            val current = api
            app.notificationMutex.withLock {
                try {
                    // Decoding a large dashboard stays off the main thread.
                    val reply = withContext(Dispatchers.Default) { current.dashboard(etag) }
                    val nowMs = System.currentTimeMillis()
                    when (reply) {
                        is DashboardResult.Fetched -> {
                            // A read while the app shows Settings or Connection must not mark new attention as seen.
                            etag = if (app.resumed) null else reply.etag
                            val threads = reply.dashboard.threads
                            synchronized(app.store) {
                                if (!app.resumed && app.store.token == token && !app.store.revoked) {
                                    val baseline = app.store.loadBaselineIfPaired(token)
                                    app.notifier.post(diff(baseline, threads, nowMs))
                                    app.store.saveBaselineIfPaired(token, AsbJson.encodeToString(update(baseline, threads, nowMs)))
                                }
                            }
                            own = LiveUpdate(threads, nowMs).also { app.liveUpdates.value = it }
                        }
                        DashboardResult.NotModified -> last?.let { own = it.copy(atMs = nowMs).also { u -> app.liveUpdates.value = u } }
                    }
                } catch (cause: AsbError) {
                    if (cause === AsbError.NotPaired) synchronized(app.store) {
                        if (app.store.token == token) {
                            app.store.revokeIfPaired(token)
                            app.notifier.postRevoked()
                            // The pairing is gone: stop now, so the shade does not also show Offline.
                            stopSelf()
                            return
                        }
                    }
                    offline = true
                    show()
                }
            }
            delay(liveIntervalMs(last?.threads, offline))
        }
    }

    private fun content(): Triple<String, List<String>, String?> {
        val update = last
        return Triple(update?.let { liveTitle(it.threads) } ?: "ASB",
            update?.let { liveLines(it.threads) }.orEmpty(),
            if (offline) liveOfflineText(update?.atMs ?: 0, System.currentTimeMillis()) else null)
    }

    // Most updates change only the time, so the same content is not posted again.
    @SuppressLint("MissingPermission")
    private fun show() {
        val content = content()
        if (content == shown) return
        try {
            getSystemService(NotificationManager::class.java).notify(LIVE_ID, build(content))
            shown = content
        } catch (_: SecurityException) {}
    }

    private fun build(content: Triple<String, List<String>, String?>): Notification {
        val (title, lines, status) = content
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 0, Intent(this, LiveService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        fun builder() = Notification.Builder(this, LIVE_CHANNEL).setSmallIcon(R.drawable.ic_stat_asb)
            .setContentTitle(title).setOngoing(true).setOnlyAlertOnce(true).setShowWhen(false)
            .setContentIntent(open).setCategory(Notification.CATEGORY_STATUS)
        return builder()
            .setContentText(status ?: lines.joinToString(", ").ifEmpty { "Checking ASB…" })
            .apply {
                if (lines.isNotEmpty()) setStyle(Notification.InboxStyle().also { style ->
                    lines.forEach { style.addLine(it) }
                    status?.let { style.setSummaryText(it) }
                })
            }
            .addAction(Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_stat_asb), "Stop", stop).build())
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(builder().apply { status?.let { setContentText(it) } }.build())
            .build()
    }
}

/** Starts the live notification again after a restart of the phone or an app update. */
class LiveStartReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            LiveService.startIfEnabled(context)
        }
    }
}
