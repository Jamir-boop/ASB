package local.asb.companion

import android.app.Application
import kotlinx.coroutines.sync.Mutex
import local.asb.companion.data.Store
import local.asb.companion.net.AsbApi

class AsbApp : Application() {
    val store by lazy { Store(this) }
    val notificationMutex = Mutex()
    @Volatile var resumed = false

    fun api(): AsbApi = synchronized(store) {
        val token = store.token
        AsbApi(store.host, store.port, store.fingerprint, token) {
            store.revokeIfPaired(token)
        }
    }
}
