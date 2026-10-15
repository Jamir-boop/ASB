package local.asb.companion

import android.app.Application
import kotlinx.coroutines.sync.Mutex
import local.asb.companion.data.Store
import local.asb.companion.net.AsbApi
import local.asb.companion.notify.CheckWorker
import local.asb.companion.notify.Notifier

class AsbApp : Application() {
    val store by lazy { Store(this) }
    val notifier by lazy { Notifier(this) }
    val notificationMutex = Mutex()
    @Volatile var resumed = false

    override fun onCreate() {
        super.onCreate()
        notifier.createChannels()
        CheckWorker.schedule(this)
    }

    fun api(): AsbApi = synchronized(store) {
        val token = store.token
        AsbApi(store.host, store.port, store.fingerprint, token) {
            store.revokeIfPaired(token)
        }
    }
}
