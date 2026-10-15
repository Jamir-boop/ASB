package local.asb.companion

import android.app.Application
import local.asb.companion.data.Store
import local.asb.companion.net.AsbApi

class AsbApp : Application() {
    val store by lazy { Store(this) }

    fun api() = AsbApi(store.host, store.port, store.fingerprint, store.token) {
        store.revoked = true
    }
}
