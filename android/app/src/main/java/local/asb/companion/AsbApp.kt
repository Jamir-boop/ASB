package local.asb.companion

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.sync.Mutex
import local.asb.companion.data.Palette
import local.asb.companion.data.Store
import local.asb.companion.net.AsbApi
import local.asb.companion.notify.CheckWorker
import local.asb.companion.notify.Notifier

class AsbApp : Application() {
    val store by lazy { Store(this) }
    val notifier by lazy { Notifier(this) }
    val notificationMutex = Mutex()
    @Volatile var resumed = false
    var palette by mutableStateOf(Palette())
        private set

    override fun onCreate() {
        super.onCreate()
        palette = store.palette ?: Palette()
        notifier.createChannels()
        CheckWorker.schedule(this)
    }

    /** Shows and saves the PC palette; null resets to the fallback (after unpair). */
    fun usePalette(value: Palette?) {
        val next = value ?: Palette()
        if (value != null && next == palette) return
        palette = next
        store.palette = value
    }

    fun api(): AsbApi = synchronized(store) {
        val token = store.token
        AsbApi(store.host, store.port, store.fingerprint, token) {
            store.revokeIfPaired(token)
        }
    }
}
