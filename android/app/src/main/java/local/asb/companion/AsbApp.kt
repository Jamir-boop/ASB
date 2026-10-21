package local.asb.companion

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import local.asb.companion.data.Endpoint
import local.asb.companion.data.Engine
import local.asb.companion.data.Palette
import local.asb.companion.data.Store
import local.asb.companion.data.otherEngines
import local.asb.companion.net.AsbApi
import local.asb.companion.net.Engines
import local.asb.companion.net.Paths
import local.asb.companion.net.pinnedConnections
import local.asb.companion.notify.CheckWorker
import local.asb.companion.notify.LiveUpdate
import local.asb.companion.notify.Notifier

class AsbApp : Application() {
    val store by lazy { Store(this) }
    val notifier by lazy { Notifier(this) }
    val notificationMutex = Mutex()
    @Volatile var resumed = false
    /** The latest dashboard rows of the current pairing, shown by the live notification. */
    val liveUpdates = MutableStateFlow<LiveUpdate?>(null)
    /** Counts the default-network changes; the session poll and the live service wake on each one. */
    val networkChanges = MutableStateFlow(0L)
    var palette by mutableStateOf(Palette())
        private set
    var textScale by mutableFloatStateOf(1f)
        private set
    var liveNotification by mutableStateOf(true)
        private set
    var useCameraArea by mutableStateOf(true)
        private set

    override fun onCreate() {
        super.onCreate()
        palette = store.palette ?: Palette()
        textScale = store.textScale
        liveNotification = store.liveNotification
        useCameraArea = store.useCameraArea
        notifier.createChannels()
        CheckWorker.schedule(this)
        // Registered on the Application for the whole process (no activity to leak), so the
        // session screen, the worker, and notification actions all see each network change.
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    if (!store.networkChanged(network.networkHandle)) return
                    // An idle socket of the old network can hang until its timeout, so no request may reuse one.
                    pinnedConnections.evictAll()
                    networkChanges.update { it + 1 }
                }
            })
    }

    /** Shows and saves the PC palette; null resets to the fallback (after unpair). */
    fun usePalette(value: Palette?) {
        val next = value ?: Palette()
        if (value != null && next == palette) return
        palette = next
        store.palette = value
    }

    /** Shows and saves the camera area setting. */
    fun chooseCameraArea(value: Boolean) {
        useCameraArea = value
        store.useCameraArea = value
    }

    /** Shows and saves the Card text size. */
    fun useTextScale(value: Float) {
        textScale = value
        store.textScale = value
    }

    /** Shows and saves the live notification switch; the Stop action in the notification also sets it. */
    fun useLiveNotification(value: Boolean) {
        liveNotification = value
        store.liveNotification = value
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
        // AsbApi writes current before endpoint, so the two keys never disagree.
        val engines = object : Engines {
            override var list: List<Engine>
                get() = otherEngines(store.engines, store.fingerprint)
                set(value) = store.saveEnginesIfPaired(token, value)
            override var current: String
                get() = store.currentEngine
                set(value) = store.saveCurrentEngineIfPaired(token, value, null)
            override var endpoint: Endpoint?
                get() = store.currentEngineEndpoint
                set(value) = store.saveCurrentEngineIfPaired(token, store.currentEngine, value)
        }
        AsbApi(paths, store.port, store.fingerprint, token, engines) {
            store.revokeIfPaired(token)
        }
    }
}
