package local.asb.companion.data

import android.content.Context
import android.content.SharedPreferences
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString

class Store(private val preferences: SharedPreferences) {
    constructor(context: Context) : this(context.getSharedPreferences("asb", Context.MODE_PRIVATE))

    // A pairing from before version 2 links saved one "host"; it reads as one lan endpoint.
    val endpoints: List<Endpoint> get() = preferences.getString("endpoints", null)?.let {
        try { orderEndpoints(AsbJson.decodeFromString<List<Endpoint>>(it)) } catch (_: SerializationException) { null }
    } ?: preferences.getString("host", null)?.let { orderEndpoints(listOf(Endpoint("lan", it))) }.orEmpty()
    /** The endpoint that answered last; null starts again at the top of the order. */
    val currentEndpoint: Endpoint? get() = preferences.getString("currentEndpoint", null)?.let {
        try { AsbJson.decodeFromString<Endpoint>(it) } catch (_: SerializationException) { null }
    }?.takeIf { it in endpoints }
    val port: Int get() = preferences.getInt("port", 4630)
    val fingerprint: String get() = preferences.getString("fingerprint", "").orEmpty()
    val token: String get() = preferences.getString("token", "").orEmpty()
    val deviceId: String get() = preferences.getString("deviceId", "").orEmpty()
    val serverName: String get() = preferences.getString("serverName", "").orEmpty()
    val paired: Boolean get() = token.isNotEmpty()
    /** The other engines of the machine group, from the last hello. */
    val engines: List<Engine> get() = preferences.getString("engines", null)?.let {
        try { AsbJson.decodeFromString<List<Engine>>(it) } catch (_: SerializationException) { null }
    }.orEmpty()
    /** The engine that answered last; "" is the paired engine. */
    val currentEngine: String get() = preferences.getString("currentEngine", "").orEmpty()
        .takeIf { id -> engines.any { it.machineId == id } }.orEmpty()
    /** The endpoint that answered for the current engine when it is not the paired one. */
    val currentEngineEndpoint: Endpoint? get() = preferences.getString("currentEngineEndpoint", null)?.let {
        try { AsbJson.decodeFromString<Endpoint>(it) } catch (_: SerializationException) { null }
    }?.takeIf { endpoint -> engines.firstOrNull { it.machineId == currentEngine }?.addresses.orEmpty().contains(endpoint) }
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
    /** The ongoing notification with the session counts, run by the live service. */
    // Draw under the camera hole (fullscreen to the top edge); off keeps the cutout band clear.
    var useCameraArea: Boolean
        get() = preferences.getBoolean("useCameraArea", true)
        set(value) { preferences.edit().putBoolean("useCameraArea", value).apply() }
    var liveNotification: Boolean
        get() = preferences.getBoolean("liveNotification", true)
        set(value) { preferences.edit().putBoolean("liveNotification", value).apply() }
    var view: String
        get() = if (preferences.getString("view", null) == "compact") "compact" else "comfortable"
        set(value) { preferences.edit().putString("view", value).apply() }
    /** The Card text size, a factor on the phone font scale. It scales the session cards only. */
    var textScale: Float
        get() = preferences.getFloat("textScale", 1f)
        set(value) { preferences.edit().putFloat("textScale", value).apply() }
    // The last good PC palette, in the dashboard shape, so the theme stays the same offline and at start.
    var palette: Palette?
        get() = preferences.getString("palette", null)?.let {
            try { Palette.parse(AsbJson.parseToJsonElement(it)) } catch (_: SerializationException) { null }
        }
        set(value) { preferences.edit().apply { if (value == null) remove("palette") else putString("palette", value.toJson()) }.apply() }
    // Provider ID to the warning text that the user dismissed; the same text stays hidden after a restart.
    var dismissedWarnings: Map<String, String>
        get() = preferences.getString("dismissedWarnings", null)?.let {
            try { AsbJson.decodeFromString<Map<String, String>>(it) } catch (_: SerializationException) { null }
        }.orEmpty()
        set(value) { preferences.edit().putString("dismissedWarnings", AsbJson.encodeToString(value)).apply() }
    var notificationPermissionAsked: Boolean
        get() = preferences.getBoolean("notificationPermissionAsked", false)
        set(value) { preferences.edit().putBoolean("notificationPermissionAsked", value).apply() }

    @Synchronized
    fun save(info: PairingInfo, reply: PairReply) {
        preferences.edit()
            .remove("host")
            .putString("endpoints", AsbJson.encodeToString(info.addresses))
            .remove("currentEndpoint")
            .putInt("port", info.port)
            .putString("fingerprint", info.fingerprint)
            .putString("token", reply.token)
            .putString("deviceId", reply.deviceId)
            .putString("serverName", reply.serverName)
            .putBoolean("revoked", false)
            .remove("baseline")
            .remove("baselineEngine")
            .remove("engines")
            .remove("currentEngine")
            .remove("currentEngineEndpoint")
            .apply()
        etag = null
    }

    @Synchronized
    fun revokeIfPaired(token: String) {
        if (token.isNotEmpty() && this.token == token) revoked = true
    }

    @Synchronized
    fun saveEndpointsIfPaired(token: String, value: List<Endpoint>) {
        if (token.isEmpty() || this.token != token) return
        preferences.edit().remove("host").putString("endpoints", AsbJson.encodeToString(value)).apply()
    }

    @Synchronized
    fun saveCurrentEndpointIfPaired(token: String, value: Endpoint?) {
        if (token.isEmpty() || this.token != token) return
        preferences.edit().apply {
            if (value == null) remove("currentEndpoint") else putString("currentEndpoint", AsbJson.encodeToString(value))
        }.apply()
    }

    @Synchronized
    fun saveEnginesIfPaired(token: String, value: List<Engine>) {
        if (token.isEmpty() || this.token != token) return
        preferences.edit().putString("engines", AsbJson.encodeToString(value)).apply()
    }

    @Synchronized
    fun saveCurrentEngineIfPaired(token: String, engine: String, endpoint: Endpoint?) {
        if (token.isEmpty() || this.token != token) return
        preferences.edit().apply {
            if (engine.isEmpty()) remove("currentEngine").remove("currentEngineEndpoint")
            else {
                putString("currentEngine", engine)
                if (endpoint == null) remove("currentEngineEndpoint") else putString("currentEngineEndpoint", AsbJson.encodeToString(endpoint))
            }
        }.apply()
    }

    /**
     * A new Android default network starts the endpoint order again; the same network keeps it, also after a restart.
     * Returns true for a new network.
     */
    @Synchronized
    fun networkChanged(handle: Long): Boolean {
        if (preferences.contains("network") && preferences.getLong("network", 0) == handle) return false
        preferences.edit().putLong("network", handle).remove("currentEndpoint").remove("currentEngineEndpoint").apply()
        return true
    }

    // Each engine keeps its own read marks, so the first dashboard of another engine only starts a new baseline.
    @Synchronized
    fun saveBaselineIfPaired(token: String, value: String, engine: String) {
        if (token.isNotEmpty() && this.token == token) preferences.edit().putString("baseline", value).putString("baselineEngine", engine).apply()
    }

    @Synchronized
    fun loadBaselineIfPaired(token: String, engine: String): Map<String, Int>? {
        if (token.isEmpty() || this.token != token) return null
        if (preferences.getString("baselineEngine", null) != engine) return null
        val value = baseline ?: return null
        return try { AsbJson.decodeFromString<Map<String, Int>>(value) }
            catch (_: SerializationException) { null }
    }

    @Synchronized
    fun clear() {
        // Phone preferences stay for the next pairing; the pairing and its state go.
        preferences.edit().clear()
            .putBoolean("notificationPermissionAsked", notificationPermissionAsked)
            .putString("view", view)
            .putFloat("textScale", textScale)
            .putBoolean("notifyDone", notifyDone)
            .putBoolean("notifyFailed", notifyFailed)
            .putBoolean("notifyInput", notifyInput)
            .putBoolean("liveNotification", liveNotification)
            .putBoolean("useCameraArea", useCameraArea)
            .apply()
        etag = null
    }
}
