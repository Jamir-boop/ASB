package local.asb.companion.data

import android.content.Context
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString

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
    var view: String
        get() = if (preferences.getString("view", null) == "compact") "compact" else "comfortable"
        set(value) { preferences.edit().putString("view", value).apply() }
    // The last good PC palette, in the dashboard shape, so the theme stays the same offline and at start.
    var palette: Palette?
        get() = preferences.getString("palette", null)?.let {
            try { Palette.parse(AsbJson.parseToJsonElement(it)) } catch (_: SerializationException) { null }
        }
        set(value) { preferences.edit().apply { if (value == null) remove("palette") else putString("palette", value.toJson()) }.apply() }
    var notificationPermissionAsked: Boolean
        get() = preferences.getBoolean("notificationPermissionAsked", false)
        set(value) { preferences.edit().putBoolean("notificationPermissionAsked", value).apply() }

    @Synchronized
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

    @Synchronized
    fun revokeIfPaired(token: String) {
        if (token.isNotEmpty() && this.token == token) revoked = true
    }

    @Synchronized
    fun saveBaselineIfPaired(token: String, value: String) {
        if (token.isNotEmpty() && this.token == token) baseline = value
    }

    @Synchronized
    fun loadBaselineIfPaired(token: String): Map<String, Int>? {
        if (token.isEmpty() || this.token != token) return null
        val value = baseline ?: return null
        return try { AsbJson.decodeFromString<Map<String, Int>>(value) }
            catch (_: SerializationException) { null }
    }

    @Synchronized
    fun clear() {
        preferences.edit().clear()
            .putBoolean("notificationPermissionAsked", notificationPermissionAsked)
            .putString("view", view)
            .apply()
        etag = null
    }
}
