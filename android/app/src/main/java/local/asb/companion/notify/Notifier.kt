package local.asb.companion.notify

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import local.asb.companion.AsbApp
import local.asb.companion.MainActivity
import local.asb.companion.R
import local.asb.companion.data.Thread
import local.asb.companion.ui.rowMenuActions

internal const val ACTION_NOTIFICATION = "local.asb.companion.NOTIFICATION"
internal const val ACTION_DISMISS = "local.asb.companion.DISMISS_NOTIFICATION"
private const val ACTION_CONTENT = "local.asb.companion.OPEN_NOTIFICATION"
private const val GROUP = "asb"
private const val SINGLE_GROUP = "asb-single"
private const val SUMMARY_TAG = "asb-summary"
private const val STATUS_TAG = "asb-status"

internal fun notificationId(id: String, kind: Int): Int = "$id:$kind".hashCode()
internal fun notificationTag(id: String, kind: Int): String = "$id:$kind"

/** The extras of a notification action: [key] names the session on every engine, [engine] gets the action. */
internal fun actionExtras(row: Thread, kind: Int, action: String, engine: String, deviceId: String): Map<String, Any> = mapOf(
    "id" to row.id, "key" to row.key, "engine" to engine, "action" to action, "kind" to kind,
    "notificationId" to notificationId(row.key, kind), "deviceId" to deviceId)

class Notifier(private val app: AsbApp) {
    private val manager = app.getSystemService(NotificationManager::class.java)

    companion object {
        fun notificationsAllowed(context: Context): Boolean =
            (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED) &&
                context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()
    }

    fun createChannels() {
        val audio = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        fun channel(id: String, name: String, importance: Int, sound: String?) =
            NotificationChannel(id, name, importance).apply {
                setSound(sound?.let { Uri.parse("android.resource://${app.packageName}/raw/$it") }, audio)
            }
        manager.createNotificationChannels(listOf(
            channel("asb_done", "Done", NotificationManager.IMPORTANCE_DEFAULT, "opencode_staplebops_01"),
            channel("asb_input", "Needs input", NotificationManager.IMPORTANCE_HIGH, "opencode_staplebops_02"),
            channel("asb_failed", "Failed", NotificationManager.IMPORTANCE_DEFAULT, "opencode_nope_03"),
            channel("asb_status", "Connection", NotificationManager.IMPORTANCE_LOW, null),
            channel("asb_live", "Live sessions", NotificationManager.IMPORTANCE_LOW, null).apply {
                enableVibration(false)
                setShowBadge(false)
            },
        ))
    }

    /** [engine] gave the rows of [events]; their actions go to it. */
    fun post(events: List<Event>, engine: String) {
        // Most reads find no new event; this skips the binder calls of the group check.
        if (events.isEmpty() || !canPost()) return
        val children = children().toMutableSet()
        for (event in events) {
            val row = event.row
            val channel = when (event.kind) {
                BIT_DONE -> if (app.store.notifyDone) "asb_done" else continue
                BIT_FAILED -> if (app.store.notifyFailed) "asb_failed" else continue
                BIT_INPUT -> if (app.store.notifyInput) "asb_input" else continue
                else -> continue
            }
            val title = when (event.kind) {
                BIT_DONE -> "Done"
                BIT_FAILED -> "Failed"
                else -> if (row.actionRequired) "Waiting for approval" else "Needs your answer"
            }
            // The key, so the same session from another engine of the group replaces its notification.
            val tag = notificationTag(row.key, event.kind)
            val id = notificationId(row.key, event.kind)
            val builder = builder(channel).setContentTitle(title)
                .setContentText(row.title.ifBlank { row.projectName }).setSubText(row.sourceLabel)
                .setContentIntent(contentIntent(tag, id)).setAutoCancel(true)
                .setDeleteIntent(broadcast(event, engine, "dismiss", ACTION_DISMISS))
            fun action(label: String, action: String) = Notification.Action.Builder(
                Icon.createWithResource(app, R.drawable.ic_stat_asb), label, broadcast(event, engine, action),
            ).build()
            if (row.canOpen) builder.addAction(action("Open on PC", "open"))
            if (rowMenuActions(row).any { it.action == "mark-read" }) builder.addAction(action("Read", "mark-read"))
            if (show(tag, id, builder.build())) children.add(tag)
        }
        summary(children)
    }

    fun postRevoked() {
        if (!canPost()) return
        val notification = builder("asb_status").setContentTitle("ASB")
            .setContentText("This phone was removed from ASB. Open the app to pair again.")
            .setContentIntent(contentIntent(STATUS_TAG, 0)).setAutoCancel(true)
            .setDeleteIntent(PendingIntent.getBroadcast(app, 0,
                Intent(app, ActionReceiver::class.java).setAction(ACTION_DISMISS)
                    .setData(Uri.Builder().scheme("asb").authority("notification").appendPath(app.store.deviceId)
                        .appendPath("status").appendPath("dismiss").build()),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)).build()
        if (show(STATUS_TAG, 0, notification)) summary(children() + STATUS_TAG)
    }

    fun opened(intent: Intent) {
        if (intent.action != ACTION_CONTENT) return
        if (intent.getStringExtra("deviceId") != app.store.deviceId || !app.store.paired) return
        val tag = intent.getStringExtra("notificationTag") ?: return
        if (!intent.hasExtra("notificationId")) return
        cancel(tag, intent.getIntExtra("notificationId", 0))
    }

    fun clear() = manager.cancelAll()

    internal fun dismissed() = summary(children())

    internal fun cancel(tag: String, id: Int) {
        manager.cancel(tag, id)
        summary(children() - tag)
    }

    internal fun failed(tag: String, id: Int) {
        if (!notificationsAllowed(app)) return
        val old = manager.activeNotifications.firstOrNull { it.tag == tag && it.id == id } ?: return
        val notification = Notification.Builder.recoverBuilder(app, old.notification)
            .setContentText("Could not reach ASB.").setOnlyAlertOnce(true)
            .setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY).build()
        if (show(tag, id, notification)) summary(children() + tag)
    }

    private fun canPost(): Boolean = !app.resumed && notificationsAllowed(app)

    @SuppressLint("MissingPermission")
    private fun show(tag: String, id: Int, notification: Notification): Boolean {
        if (!notificationsAllowed(app)) return false
        val channel = manager.getNotificationChannel(notification.channelId) ?: return false
        if (channel.importance == NotificationManager.IMPORTANCE_NONE) return false
        return try { manager.notify(tag, id, notification); true }
            catch (_: SecurityException) { false }
    }

    private fun children(): Set<String> = manager.activeNotifications.filter {
        (it.notification.group == GROUP || it.notification.group == SINGLE_GROUP) &&
            it.notification.flags and Notification.FLAG_GROUP_SUMMARY == 0
    }.mapNotNull { it.tag }.toSet()

    private fun summary(children: Set<String>) {
        val active = manager.activeNotifications
        val hasSummary = active.any { it.tag == SUMMARY_TAG }
        val group = if (children.size >= 2) GROUP else SINGLE_GROUP
        if (children.size >= 2 || hasSummary) for (child in active) {
            val tag = child.tag ?: continue
            if (tag !in children || child.notification.group == group) continue
            // A separate group keeps the queued survivor safe when Android cancels summary children.
            show(tag, child.id, Notification.Builder.recoverBuilder(app, child.notification)
                .setGroup(group).setOnlyAlertOnce(true).setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY).build())
        }
        if (children.size < 2) manager.cancel(SUMMARY_TAG, 0)
        else if (!app.resumed || hasSummary)
            show(SUMMARY_TAG, 0, builder("asb_status").setContentTitle("ASB")
            .setContentText("${children.size} session updates").setGroupSummary(true)
            .setOnlyAlertOnce(true).setContentIntent(contentIntent()).build())
    }

    private fun builder(channel: String): Notification.Builder = Notification.Builder(app, channel)
        .setSmallIcon(R.drawable.ic_stat_asb).setGroup(GROUP)
        .setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
        .setVisibility(Notification.VISIBILITY_PRIVATE)
        .setPublicVersion(Notification.Builder(app, channel).setSmallIcon(R.drawable.ic_stat_asb)
            .setContentTitle("ASB").setContentText("A session needs attention").build())

    private fun contentIntent(tag: String? = null, id: Int = 0): PendingIntent {
        val intent = Intent(app, MainActivity::class.java).setAction(ACTION_CONTENT)
            .setData(Uri.Builder().scheme("asb").authority("notification").appendPath(app.store.deviceId)
                .appendPath(tag ?: "summary").build())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("deviceId", app.store.deviceId)
        if (tag != null) intent.putExtra("notificationTag", tag).putExtra("notificationId", id)
        return PendingIntent.getActivity(app, id, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun broadcast(event: Event, engine: String, action: String, intentAction: String = ACTION_NOTIFICATION): PendingIntent {
        val intent = Intent(app, ActionReceiver::class.java).setAction(intentAction)
            .setData(Uri.Builder().scheme("asb").authority("notification").appendPath(app.store.deviceId).appendPath(event.row.key)
                .appendPath(event.kind.toString()).appendPath(action).build())
        for ((name, value) in actionExtras(event.row, event.kind, action, engine, app.store.deviceId)) {
            if (value is Int) intent.putExtra(name, value) else intent.putExtra(name, value as String)
        }
        return PendingIntent.getBroadcast(app, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
}
