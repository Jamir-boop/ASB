package local.asb.companion.notify

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import local.asb.companion.AsbApp
import local.asb.companion.data.AsbJson
import local.asb.companion.net.AsbError
import local.asb.companion.net.DashboardResult

// A manual check is pressed inside the app, so it must post even while the app is resumed.
internal fun shouldPost(manual: Boolean, resumed: Boolean): Boolean = manual || !resumed

class CheckWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val app = applicationContext as AsbApp
        // The live service or the screen read less than a minute ago; a Doze-frozen service has an old time, so this check still runs.
        if (!inputData.getBoolean("manual", false) && app.store.liveNotification &&
            (app.liveUpdates.value?.atMs ?: 0) > System.currentTimeMillis() - 60_000) return Result.success()
        app.notificationMutex.withLock {
            val pair = synchronized(app.store) {
                if (!app.store.paired || app.store.revoked) null else app.store.token to app.api()
            } ?: return Result.success()
            val (token, api) = pair
            try {
                val reply = api.dashboard(null, false)
                if (reply is DashboardResult.Fetched) withContext(Dispatchers.Main.immediate) {
                    synchronized(app.store) {
                        if (app.store.token == token && !app.store.revoked) {
                            val baseline = app.store.loadBaselineIfPaired(token, reply.engine)
                            val nowMs = System.currentTimeMillis()
                            if (shouldPost(inputData.getBoolean("manual", false), app.resumed)) {
                                app.notifier.post(diff(baseline, reply.dashboard.threads, nowMs), reply.engine)
                                app.notifier.cancelCleared(cleared(baseline, reply.dashboard.threads, reply.engine, nowMs))
                                // An automatic check while the app is open must not mark new attention as seen.
                                app.store.saveBaselineIfPaired(token,
                                    AsbJson.encodeToString(update(baseline, reply.dashboard.threads, nowMs)), reply.engine)
                            }
                        }
                    }
                }
            } catch (cause: AsbError) {
                if (cause === AsbError.NotPaired) withContext(Dispatchers.Main.immediate) {
                    synchronized(app.store) {
                        if (app.store.token == token) {
                            app.store.revokeIfPaired(token)
                            app.notifier.postRevoked()
                        }
                    }
                }
                // The next scheduled check handles offline and server failures without retries.
            }
        }
        return Result.success()
    }

    companion object {
        fun schedule(context: Context) {
            val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            val request = PeriodicWorkRequestBuilder<CheckWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("asb-check", ExistingPeriodicWorkPolicy.KEEP, request)
        }

        fun checkNow(context: Context) {
            WorkManager.getInstance(context).enqueueUniqueWork("asb-check-now", ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<CheckWorker>().setInputData(workDataOf("manual" to true)).build())
        }
    }
}
