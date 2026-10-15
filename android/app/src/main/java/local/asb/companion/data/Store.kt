package local.asb.companion.data

import android.content.Context

class Store(context: Context) {
    private val preferences = context.getSharedPreferences("asb", Context.MODE_PRIVATE)

    val host: String get() = preferences.getString("host", "").orEmpty()
    val port: Int get() = preferences.getInt("port", 4630)
    val fingerprint: String get() = preferences.getString("fingerprint", "").orEmpty()
    val token: String get() = preferences.getString("token", "").orEmpty()
    val deviceId: String get() = preferences.getString("deviceId", "").orEmpty()
    val serverName: String get() = preferences.getString("serverName", "").orEmpty()
    val paired: Boolean get() = token.isNotEmpty()
    var etag: String? = null

    var revoked: Boolean
        get() = preferences.getBoolean("revoked", false)
        set(value) { preferences.edit().putBoolean("revoked", value).apply() }
    var baseline: String?
        get() = preferences.getString("baseline", null)
        set(value) { preferences.edit().putString("baseline", value).apply() }
    var notifyDone: Boolean
        get() = preferences.getBoolean("notifyDone", true)
        set(value) { preferences.edit().putBoolean("notifyDone", value).apply() }
    var notifyFailed: Boolean
        get() = preferences.getBoolean("notifyFailed", true)
        set(value) { preferences.edit().putBoolean("notifyFailed", value).apply() }
    var notifyInput: Boolean
        get() = preferences.getBoolean("notifyInput", true)
        set(value) { preferences.edit().putBoolean("notifyInput", value).apply() }

    fun save(info: PairingInfo, reply: PairReply) {
        preferences.edit()
            .putString("host", info.host)
            .putInt("port", info.port)
            .putString("fingerprint", info.fingerprint)
            .putString("token", reply.token)
            .putString("deviceId", reply.deviceId)
            .putString("serverName", reply.serverName)
            .putBoolean("revoked", false)
            .remove("baseline")
            .apply()
        etag = null
    }

    fun clear() {
        preferences.edit().clear().apply()
        etag = null
    }
}
