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
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import local.asb.companion.AsbApp
import local.asb.companion.data.AsbJson
import local.asb.companion.net.AsbError
import local.asb.companion.net.DashboardResult

class CheckWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val app = applicationContext as AsbApp
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
                            val baseline = app.store.loadBaselineIfPaired(token)
                            val nowMs = System.currentTimeMillis()
                            if (!app.resumed) app.notifier.post(diff(baseline, reply.dashboard.threads, nowMs))
                            app.store.saveBaselineIfPaired(token,
                                AsbJson.encodeToString(update(baseline, reply.dashboard.threads, nowMs)))
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
                OneTimeWorkRequestBuilder<CheckWorker>().build())
        }
    }
}
