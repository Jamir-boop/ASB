package local.asb.companion.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import local.asb.companion.AsbApp
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Thread
import local.asb.companion.net.AsbError
import local.asb.companion.net.DashboardResult

internal fun actionOpened(reply: JsonObject): Boolean = (reply["opened"] as? JsonPrimitive)?.let {
    !it.isString && it.booleanOrNull == true
} == true

// A merge may only clear bits: a bit that the action reply adds was never notified.
internal fun mergeActionBaseline(baseline: Map<String, Int>?, row: Thread, nowMs: Long): Map<String, Int>? =
    baseline?.let { it + (row.id to ((it[row.id] ?: 0) and update(it, listOf(row), nowMs).getValue(row.id))) }

class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as AsbApp
        if (intent.action == ACTION_DISMISS) { app.notifier.dismissed(); return }
        if (intent.action != ACTION_NOTIFICATION) return
        val id = intent.getStringExtra("id")?.takeIf { it.isNotEmpty() } ?: return
        val action = intent.getStringExtra("action")?.takeIf { it == "open" || it == "mark-read" } ?: return
        val kind = intent.getIntExtra("kind", 0)
        if (kind !in setOf(BIT_DONE, BIT_FAILED, BIT_INPUT)) return
        val notificationId = notificationId(id, kind)
        if (!intent.hasExtra("notificationId") || intent.getIntExtra("notificationId", 0) != notificationId) return
        val deviceId = intent.getStringExtra("deviceId") ?: return
        val token = synchronized(app.store) {
            if (!app.store.paired || app.store.revoked || app.store.deviceId != deviceId) null else app.store.token
        } ?: return
        val tag = notificationTag(id, kind)
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            var succeeded = false
            try {
                withTimeout(10_000) {
                    app.notificationMutex.withLock {
                        val api = synchronized(app.store) {
                            if (app.store.token != token || app.store.revoked || app.store.deviceId != deviceId) null
                            else app.api()
                        } ?: return@withLock
                        val reply = api.action(id, action)
                        val row = if (action == "mark-read") {
                            val value = reply["thread"] ?: throw AsbError.Server("ASB sent an invalid response.")
                            AsbJson.decodeFromJsonElement<Thread>(value).also {
                                if (it.id != id) throw AsbError.Server("ASB sent an invalid response.")
                            }
                        } else {
                            if (!actionOpened(reply)) throw AsbError.Server("ASB could not open this session.")
                            null
                        }
                        succeeded = true
                        val updated = row ?: try {
                            (api.dashboard(null, false) as? DashboardResult.Fetched)?.dashboard?.threads?.find { it.id == id }
                        } catch (_: AsbError) { null }
                        // Commit a successful Read before cancellation can release the shared lock.
                        withContext(NonCancellable + Dispatchers.Main.immediate) {
                            synchronized(app.store) {
                                if (app.store.token == token) {
                                    if (!app.store.revoked && updated != null) mergeActionBaseline(app.store.loadBaselineIfPaired(token),
                                        updated, System.currentTimeMillis())?.let {
                                        app.store.saveBaselineIfPaired(token, AsbJson.encodeToString(it))
                                    }
                                    app.notifier.cancel(tag, notificationId)
                                    if (app.store.revoked) app.notifier.postRevoked()
                                }
                            }
                        }
                    }
                }
            } catch (cause: Exception) {
                withContext(Dispatchers.Main.immediate) {
                    synchronized(app.store) {
                        if (app.store.token == token) {
                            if (succeeded) app.notifier.cancel(tag, notificationId)
                            else app.notifier.failed(tag, notificationId)
                            if (cause === AsbError.NotPaired) app.notifier.postRevoked()
                        }
                    }
                }
            } finally {
                pending.finish()
            }
        }
    }
}
