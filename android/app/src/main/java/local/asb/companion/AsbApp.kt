package local.asb.companion

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.sync.Mutex
import local.asb.companion.data.Endpoint
import local.asb.companion.data.Palette
import local.asb.companion.data.Store
import local.asb.companion.net.AsbApi
import local.asb.companion.net.Paths
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
        // Registered on the Application for the whole process (no activity to leak), so the
        // session screen, the worker, and notification actions all see each network change.
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = store.networkChanged(network.networkHandle)
            })
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
        // Writes go only to the pairing of this token, so an old API cannot change a new pairing.
        val paths = object : Paths {
            override var endpoints: List<Endpoint>
                get() = store.endpoints
                set(value) = store.saveEndpointsIfPaired(token, value)
            override var current: Endpoint?
                get() = store.currentEndpoint
                set(value) = store.saveCurrentEndpointIfPaired(token, value)
        }
        AsbApi(paths, store.port, store.fingerprint, token) {
            store.revokeIfPaired(token)
        }
    }
}
