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
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch
import local.asb.companion.AsbApp
import local.asb.companion.MainActivity
import local.asb.companion.R
import local.asb.companion.data.Thread
import local.asb.companion.ui.cardTitle
import local.asb.companion.ui.openMachine
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

/** The card state word and the machine, for example `Needs your answer · studio-pc`. */
internal fun notificationTitle(row: Thread, kind: Int, serverName: String = ""): String = when (kind) {
    BIT_DONE -> "Done"
    BIT_FAILED -> if (row.lastOutcome == "limit") "Usage limit" else if (row.processEnded) "Process ended" else "Failed"
    else -> if (row.actionRequired) "Waiting for approval" else "Needs your answer"
} + " · " + openMachine(row, serverName)

/** The words of a notification; [bigText] is the expanded text, or null for none. */
internal data class NotificationWords(val title: String, val text: String, val subText: String = "", val bigText: String? = null)

/** The private version: the card words, and the question text of a Needs input row while the PC sends it. */
internal fun notificationWords(row: Thread, kind: Int, serverName: String): NotificationWords = NotificationWords(
    notificationTitle(row, kind, serverName), cardTitle(row), row.sourceLabel,
    row.questionText.takeIf { kind == BIT_INPUT && it.isNotBlank() })

/** The public version of the group summary and the connection notification. */
internal val PUBLIC_WORDS = NotificationWords("ASB", "A session needs attention")

/** The public version (lock screen) of a session notification: the kind only, no session words and no question. */
internal fun publicWords(row: Thread, kind: Int): NotificationWords = NotificationWords("ASB", when (kind) {
    BIT_DONE -> "A task is done"
    BIT_FAILED -> if (row.lastOutcome == "limit") "A task hit a usage limit" else "A task failed"
    else -> "A session needs your answer"
})

/** What each kind covers: the channel descriptions and the Settings captions. */
internal const val ABOUT_DONE = "A session finished a task."
internal const val ABOUT_INPUT = "A session waits for your answer or approval."
internal const val ABOUT_FAILED = "A task failed or hit a usage limit."

internal fun notificationCategory(kind: Int): String = when (kind) {
    BIT_DONE -> Notification.CATEGORY_STATUS
    BIT_FAILED -> Notification.CATEGORY_ERROR
    else -> Notification.CATEGORY_REMINDER
}

/** The group summary text from the child tags (`key:kind`), for example `3 alerts: 1 needs input · 1 failed · 1 done`. */
internal fun summaryText(tags: Collection<String>): String {
    val kinds = tags.mapNotNull { it.substringAfterLast(':', "").toIntOrNull() }
    // The summary exists only for 2 or more children, so the word is always alerts.
    return "${tags.size} alerts" + listOf(BIT_INPUT to "needs input", BIT_FAILED to "failed", BIT_DONE to "done")
        .mapNotNull { (kind, word) -> kinds.count { it == kind }.takeIf { it > 0 }?.let { "$it $word" } }
        .joinToString(" · ").let { if (it.isEmpty()) "" else ": $it" }
}

internal fun channelFor(kind: Int): String = when (kind) {
    BIT_DONE -> "asb_done"
    BIT_FAILED -> "asb_failed"
    else -> "asb_input"
}

/** What a session notification shows; a post and a text-off re-post build from it, so the two are equal. */
internal data class ChildSpec(
    val channel: String, val words: NotificationWords, val public: NotificationWords, val category: String,
    val group: String, val actions: List<Pair<String, String>>, val whenMs: Long? = null, val onlyAlertOnce: Boolean = false,
)

internal fun childSpec(row: Thread, kind: Int, serverName: String): ChildSpec = ChildSpec(channelFor(kind),
    notificationWords(row, kind, serverName), publicWords(row, kind), notificationCategory(kind), GROUP,
    listOfNotNull(("Open on PC" to "open").takeIf { row.canOpen },
        ("Mark read" to "mark-read").takeIf { rowMenuActions(row).any { it.action == "mark-read" } }))

/**
 * An active notification: [hasBigText] is true when it shows an expanded (question) text; [whenMs] is its time;
 * [group] is its group now (asb, or asb-single after summary() moved it).
 */
internal data class ActiveChild(val tag: String, val id: Int, val hasBigText: Boolean, val whenMs: Long, val group: String = GROUP)

internal data class Repost(val child: ActiveChild, val row: Thread)

/**
 * The Needs input children that show a question text while their row has none now (the PC switch is off, or the
 * question is gone). A row that is gone or no longer needs input is the cancel path, not this one. As in [cleared],
 * the remote rows of another engine prove nothing.
 */
internal fun textOffReposts(active: List<ActiveChild>, threads: List<Thread>, engine: String): List<Repost> {
    val rows = threads.filter { engine.isEmpty() || !it.remote }.associateBy { notificationTag(it.key, BIT_INPUT) }
    return active.mapNotNull { child ->
        rows[child.tag]?.takeIf { child.hasBigText && it.questionText.isBlank() && bits(it) and BIT_INPUT != 0 }
            ?.let { Repost(child, it) }
    }
}

/** The extras of a notification action: [key] names the session on every engine, [engine] gets the action. */
internal fun actionExtras(row: Thread, kind: Int, action: String, engine: String, deviceId: String): Map<String, Any> = mapOf(
    "id" to row.id, "key" to row.key, "engine" to engine, "action" to action, "kind" to kind,
    "notificationId" to notificationId(row.key, kind), "deviceId" to deviceId)

class Notifier(private val app: AsbApp) {
    private val manager = app.getSystemService(NotificationManager::class.java)

    init {
        // The session screen poll and the live service publish each good read here; the worker calls dropQuestionText.
        MainScope().launch { app.liveUpdates.collect { update -> update?.let { dropQuestionText(it.threads, it.engine) } } }
    }

    companion object {
        fun notificationsAllowed(context: Context): Boolean =
            (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED) &&
                context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()
    }

    fun createChannels() {
        val audio = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        // The same IDs keep the sound and style that the user set; a new description changes nothing else.
        fun channel(id: String, name: String, importance: Int, sound: String?, about: String) =
            NotificationChannel(id, name, importance).apply {
                setSound(sound?.let { Uri.parse("android.resource://${app.packageName}/raw/$it") }, audio)
                description = about
            }
        manager.createNotificationChannels(listOf(
            channel("asb_done", "Done", NotificationManager.IMPORTANCE_DEFAULT, "opencode_staplebops_01",
                ABOUT_DONE),
            channel("asb_input", "Needs input", NotificationManager.IMPORTANCE_HIGH, "opencode_staplebops_02",
                ABOUT_INPUT),
            channel("asb_failed", "Failed", NotificationManager.IMPORTANCE_DEFAULT, "opencode_nope_03",
                ABOUT_FAILED),
            channel("asb_status", "Connection", NotificationManager.IMPORTANCE_LOW, null,
                "The PC stopped answering or removed this phone."),
            channel("asb_live", "Live sessions", NotificationManager.IMPORTANCE_LOW, null,
                "Counts of pending and working sessions while ASB runs.").apply {
                enableVibration(false)
                setShowBadge(false)
            },
        ))
    }

    /** [engine] gave the rows of [events]; their actions go to it. */
    fun post(events: List<Event>, engine: String) {
        // Most reads find no new event; this skips the binder calls of the group check.
        if (events.isEmpty() || !notificationsAllowed(app)) return
        val children = children().toMutableSet()
        for (event in events) {
            val row = event.row
            val on = when (event.kind) {
                BIT_DONE -> app.store.notifyDone
                BIT_FAILED -> app.store.notifyFailed
                BIT_INPUT -> app.store.notifyInput
                else -> false
            }
            if (!on) continue
            // The key, so the same session from another engine of the group replaces its notification.
            val tag = notificationTag(row.key, event.kind)
            val id = notificationId(row.key, event.kind)
            if (show(tag, id, child(childSpec(row, event.kind, app.store.serverName), event, engine, tag, id))) children.add(tag)
        }
        summary(children)
    }

    /**
     * Posts again, with no question text, each Needs input child whose row lost its question (see [textOffReposts]).
     * The re-post keeps the old time and does not alert, so the child makes no sound and does not move up.
     */
    fun dropQuestionText(threads: List<Thread>, engine: String) {
        // Most reads have no Needs input row without a question; this skips the binder call.
        if (threads.none { it.questionText.isBlank() && bits(it) and BIT_INPUT != 0 }) return
        val active = manager.activeNotifications.mapNotNull { item ->
            item.tag?.let { ActiveChild(it, item.id, item.notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT) != null,
                item.notification.`when`, item.notification.group ?: GROUP) }
        }
        // The same group as now, so the summary and the other children do not change.
        for ((child, row) in textOffReposts(active, threads, engine)) show(child.tag, child.id, child(
            childSpec(row, BIT_INPUT, app.store.serverName).copy(whenMs = child.whenMs, onlyAlertOnce = true, group = child.group),
            Event(row, BIT_INPUT), engine, child.tag, child.id))
    }

    private fun child(spec: ChildSpec, event: Event, engine: String, tag: String, id: Int): Notification {
        val builder = builder(spec.channel, spec.public).setGroup(spec.group).setContentTitle(spec.words.title)
            .setContentText(spec.words.text).setSubText(spec.words.subText).setCategory(spec.category)
            .setContentIntent(contentIntent(tag, id)).setAutoCancel(true).setOnlyAlertOnce(spec.onlyAlertOnce)
            .setDeleteIntent(broadcast(event, engine, "dismiss", ACTION_DISMISS))
        spec.whenMs?.let { builder.setWhen(it) }
        // Only the private version: the public version from builder() keeps its words on the lock screen.
        spec.words.bigText?.let { builder.setStyle(Notification.BigTextStyle().bigText(it)) }
        for ((label, action) in spec.actions) builder.addAction(Notification.Action.Builder(
            Icon.createWithResource(app, R.drawable.ic_stat_asb), label, broadcast(event, engine, action)).build())
        return builder.build()
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

    /** Cancels the active notifications of [cleared] and updates the group summary once. */
    fun cancelCleared(cleared: List<Cleared>) {
        // No notificationsAllowed check, unlike post(): a cancel needs no permission, and an old notification must go
        // also when its kind is off now. An empty list (no baseline, no rows) makes no binder call.
        if (cleared.isEmpty()) return
        val active = manager.activeNotifications.mapNotNull { item -> item.tag?.let { it to item.id } }.toSet()
        val gone = cleared.map { notificationTag(it.key, it.kind) to notificationId(it.key, it.kind) }.filter { it in active }.toSet()
        if (gone.isEmpty()) return
        for ((tag, id) in gone) manager.cancel(tag, id)
        summary(children() - gone.map { it.first }.toSet())
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
            // A child that Android moved to its own auto-group (overrideGroupKey) goes back to the app group.
            if (tag !in children || (child.notification.group == group && child.overrideGroupKey == null)) continue
            // A separate group keeps the queued survivor safe when Android cancels summary children.
            show(tag, child.id, Notification.Builder.recoverBuilder(app, child.notification)
                .setGroup(group).setOnlyAlertOnce(true).setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY).build())
        }
        // Also while the app is open (Check now): a group with no summary is one that Android 16 auto-groups.
        if (children.size < 2) manager.cancel(SUMMARY_TAG, 0)
        else show(SUMMARY_TAG, 0, builder("asb_status").setContentTitle("ASB")
            .setContentText(summaryText(children)).setGroupSummary(true)
            .setOnlyAlertOnce(true).setContentIntent(contentIntent()).build())
    }

    private fun builder(channel: String, public: NotificationWords = PUBLIC_WORDS): Notification.Builder = Notification.Builder(app, channel)
        .setSmallIcon(R.drawable.ic_stat_asb).setGroup(GROUP)
        .setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
        .setVisibility(Notification.VISIBILITY_PRIVATE)
        .setPublicVersion(Notification.Builder(app, channel).setSmallIcon(R.drawable.ic_stat_asb)
            .setContentTitle(public.title).setContentText(public.text).build())

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
