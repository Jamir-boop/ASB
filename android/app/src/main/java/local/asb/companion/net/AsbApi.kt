package local.asb.companion.net

import java.io.IOException
import java.security.cert.CertificateException
import javax.net.ssl.SSLPeerUnverifiedException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import local.asb.companion.data.ActivityMessages
import local.asb.companion.data.ActivityUsage
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Dashboard
import local.asb.companion.data.Endpoint
import local.asb.companion.data.Engine
import local.asb.companion.data.ErrorReply
import local.asb.companion.data.Hello
import local.asb.companion.data.MESSAGE_PERIODS
import local.asb.companion.data.PairReply
import local.asb.companion.data.PairingInfo
import local.asb.companion.data.USAGE_PERIODS
import local.asb.companion.data.endpointLabel
import local.asb.companion.data.orderEndpoints
import local.asb.companion.data.otherEngines
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

sealed class AsbError(message: String) : Exception(message) {
    /** [overlays] names the ZeroTier and Tailscale endpoints of the pairing, for the away-from-home hint. */
    class Offline(val overlays: List<String> = emptyList()) : AsbError(offlineMessage(overlays))
    data object NotPaired : AsbError("This phone was removed from ASB. Pair again.")
    data object Throttled : AsbError("Too many attempts. Wait one minute, then try again.")
    data object PinMismatch : AsbError("The ASB certificate does not match the paired PC. Check the fingerprint in ASB Preferences.")
    class Server(message: String) : AsbError(message)
}

// An engine without the activity routes answers 404.
const val OLDER_ENGINE = "This PC runs an older ASB. Update ASB on the PC to see messages and usage."

fun offlineMessage(overlays: List<String>): String =
    if (overlays.isEmpty()) "Could not reach ASB. Check the PC and Wi-Fi, then try again."
    else "Could not reach ASB. Check the PC and Wi-Fi. Away from home? Turn on ${overlays.joinToString(" or ")} on this phone."

/** The addresses of the PC and the one that answered last; the Store keeps them for the paired PC. */
interface Paths {
    var endpoints: List<Endpoint>
    var current: Endpoint?
}

class MemoryPaths(override var endpoints: List<Endpoint>, override var current: Endpoint? = null) : Paths

/** The other engines of the group and the one that answered last ("" is the paired engine); the Store keeps them. */
interface Engines {
    var list: List<Engine>
    var current: String
    var endpoint: Endpoint?
}

class MemoryEngines(override var list: List<Engine> = emptyList(), override var current: String = "",
    override var endpoint: Endpoint? = null) : Engines

sealed interface DashboardResult {
    /** [engine] is the engine that answered ("" is the paired one); actions on these rows go to it. */
    data class Fetched(val dashboard: Dashboard, val etag: String?, val engine: String = "") : DashboardResult
    data object NotModified : DashboardResult
}

/**
 * A GET tries the current engine, then the paired engine, then the other engines of the group, each at its endpoints
 * in order, and the first that answers becomes current. An authenticated POST goes only to the first endpoint of one
 * engine and is never sent again to another one, so an action cannot run twice. The pairing POST (no token) tries every
 * endpoint of its link in order, like a GET.
 */
class AsbApi(
    private val paths: Paths,
    private val port: Int,
    private val fingerprint: String,
    private val token: String = "",
    private val engines: Engines = MemoryEngines(),
    private val clock: () -> Long = System::currentTimeMillis,
    private val onNotPaired: () -> Unit = {},
) {
    private val client = pinnedClient(fingerprint)
    private val clients = mutableMapOf(fingerprint to client)
    @Volatile private var pairedTriedAtMs: Long? = null

    /** The endpoint that answered last on the current engine, or null before the first answer on this network. */
    val endpoint: Endpoint? get() = if (engines.current.isEmpty()) paths.current else engines.endpoint

    /** The engine that answered last; "" is the paired engine. */
    val engine: String get() = engines.current

    /** The name of another engine of the group; null for the paired engine or an unknown ID. */
    fun engineName(id: String): String? = if (id.isEmpty()) null else engines.list.firstOrNull { it.machineId == id }?.name

    companion object {
        suspend fun pair(info: PairingInfo, deviceName: String): PairReply {
            val api = AsbApi(MemoryPaths(info.addresses), info.port, info.fingerprint)
            val body = buildJsonObject { put("code", info.code); put("deviceName", deviceName) }
            val response = api.request("pair", body = body.toString(), authenticated = false, secret = info.code)
            val reply = decode<PairReply>(response.body)
            if (reply.api != 1 || !reply.deviceId.matches(Regex("[0-9a-f]{12}")) ||
                !reply.token.matches(Regex("[A-Za-z0-9_-]{43}"))) invalidReply()
            return reply
        }

        private inline fun <reified T> decode(body: String): T = try {
            AsbJson.decodeFromString<T>(body)
        } catch (_: SerializationException) {
            invalidReply()
        }

        private fun invalidReply(): Nothing = throw AsbError.Server("ASB sent an invalid response. Try again.")
    }

    suspend fun hello(): Hello {
        val response = request("hello")
        val reply = validHello(response.body) ?: invalidReply()
        // Only the paired PC gives the addresses of the pairing; another engine lists its own.
        if (response.engine.isEmpty()) {
            val fresh = orderEndpoints(reply.addresses)
            if (fresh.isNotEmpty() && fresh != paths.endpoints) {
                paths.endpoints = fresh
                if (paths.current !in fresh) paths.current = null
            }
        }
        val list = otherEngines(reply.engines, fingerprint)
        if (list != engines.list) {
            engines.list = list
            if (engines.current.isNotEmpty() && list.none { it.machineId == engines.current }) useEngine("", null)
        }
        return reply
    }

    /** A hello to one engine only, which changes no current value or list; true when it answers as ASB. */
    suspend fun probe(engine: String): Boolean = try {
        validHello(request("hello", only = engine, probe = true).body) != null
    } catch (cause: AsbError) {
        false
    }

    private fun validHello(body: String): Hello? = try {
        AsbJson.decodeFromString<Hello>(body).takeIf { it.api == 1 && it.deviceId.matches(Regex("[0-9a-f]{12}")) }
    } catch (_: SerializationException) {
        null
    }

    suspend fun dashboard(etag: String? = null, force: Boolean = false, etagEngine: String = ""): DashboardResult {
        val response = request("dashboard", etag = etag, etagEngine = etagEngine, force = force, allowNotModified = true)
        return if (response.code == 304) DashboardResult.NotModified
        // The list keys need unique row IDs; an engine with a reader bug can send a row twice. Keep the first.
        else DashboardResult.Fetched(decode<Dashboard>(response.body).let { it.copy(threads = it.threads.distinctBy { row -> row.id }) },
            response.etag, response.engine)
    }

    suspend fun action(id: String, action: String, body: String = "{}", engine: String = ""): JsonObject {
        if (id.isEmpty() || id == "." || id == "..") throw AsbError.Server("Invalid session ID.")
        if (action !in setOf("open", "mark-read", "mark-unread", "pin", "unpin", "move-pin",
            "discard-result", "keep-result", "drawer-in", "drawer-out")) throw AsbError.Server("Invalid ASB action.")
        val parsed = try { AsbJson.parseToJsonElement(body) } catch (_: SerializationException) { null }
        if (parsed !is JsonObject) throw AsbError.Server("Invalid action body.")
        return decode<JsonObject>(request("threads", id, action, body = body, only = engine).body)
    }

    suspend fun setPersistentUnread(value: Boolean, engine: String = "") {
        val body = buildJsonObject { put("persistentUnread", value) }
        request("settings", "unread", body = body.toString(), only = engine)
    }

    /** The Messages view of [engine], the engine of the dashboard on screen, so seat IDs equal its row IDs. */
    suspend fun activityMessages(period: String, engine: String): ActivityMessages {
        if (period !in MESSAGE_PERIODS) throw AsbError.Server("Invalid period.")
        return decode(request("activity", "messages", query = mapOf("period" to period), only = engine,
            notFound = OLDER_ENGINE).body)
    }

    suspend fun activityUsage(period: String, engine: String): ActivityUsage {
        if (period !in USAGE_PERIODS) throw AsbError.Server("Invalid period.")
        return decode(try {
            request("activity", "usage", query = mapOf("period" to period), only = engine, notFound = OLDER_ENGINE).body
        } catch (cause: AsbError.Server) {
            // An older gateway answers period=all with HTTP 400.
            if (period == "all" && cause.message == "Invalid period.") throw AsbError.Server("This PC runs an older ASB. Update ASB on the PC to see All time.")
            throw cause
        })
    }

    private data class Reply(val code: Int, val body: String, val etag: String?, val engine: String = "")

    /** One engine to try: "" is the paired PC; another engine has its own addresses, port, and pin. */
    private class Target(val id: String, val endpoints: List<Endpoint>, val port: Int, val client: OkHttpClient)

    private fun pairedTarget(): Target {
        val endpoints = paths.endpoints
        val first = paths.current?.takeIf { it in endpoints } ?: endpoints.firstOrNull()
        return Target("", first?.let { listOf(it) + (endpoints - it) }.orEmpty(), port, client)
    }

    private fun engineTarget(engine: Engine): Target {
        val first = engines.endpoint?.takeIf { engines.current == engine.machineId && it in engine.addresses }
        val endpoints = first?.let { listOf(it) + (engine.addresses - it) } ?: engine.addresses
        val pinned = synchronized(clients) { clients.getOrPut(engine.fingerprint) { pinnedClient(engine.fingerprint) } }
        return Target(engine.machineId, endpoints, engine.port, pinned)
    }

    private fun target(id: String): Target? =
        if (id.isEmpty()) pairedTarget() else engines.list.firstOrNull { it.machineId == id }?.let(::engineTarget)

    private fun getOrder(): List<Target> {
        val list = engines.list
        val current = engines.current.takeIf { id -> list.any { it.machineId == id } }.orEmpty()
        val others = list.filter { it.machineId != current }.map(::engineTarget)
        if (current.isEmpty()) return listOf(pairedTarget()) + others
        // A phone on another engine tries its paired PC first again once a minute, so it returns when that PC is back.
        val retry = pairedTriedAtMs?.let { clock() - it >= 60_000 } ?: true
        val first = listOfNotNull(target(current))
        return if (retry) listOf(pairedTarget()) + first + others else first + pairedTarget() + others
    }

    private fun useEngine(id: String, endpoint: Endpoint?) {
        if (engines.current != id) engines.current = id
        if (engines.endpoint != endpoint) engines.endpoint = endpoint
    }

    private suspend fun request(
        vararg segments: String,
        body: String? = null,
        authenticated: Boolean = true,
        etag: String? = null,
        etagEngine: String = "",
        force: Boolean = false,
        allowNotModified: Boolean = false,
        secret: String = "",
        only: String? = null,
        probe: Boolean = false,
        query: Map<String, String> = emptyMap(),
        notFound: String? = null,
    ): Reply = withContext(Dispatchers.IO) {
        // A POST names its engine, because remote row IDs differ per engine.
        val targets = if (only != null || body != null) listOfNotNull(target(only.orEmpty())) else getOrder()
        var tried = 0
        var hints = emptyList<Endpoint>()
        var pinMismatches = 0
        var response: Reply? = null
        search@ for (target in targets) {
            if (target.id.isEmpty() && !probe) pairedTriedAtMs = clock()
            // The away-from-home hint names every overlay of a tried engine, also when a POST tried only one endpoint.
            hints = hints + target.endpoints
            // Pairing sends no token, and the PC accepts a code one time only (a second use gets 403), so it can try the next endpoint.
            for (endpoint in if (body != null && authenticated) target.endpoints.take(1) else target.endpoints) {
                ensureActive()
                tried++
                val url = HttpUrl.Builder().scheme("https").host(endpoint.host).port(target.port).addPathSegments("phone/v1").apply {
                    segments.forEach { addPathSegment(it) }
                    if (force) addQueryParameter("force", "1")
                    query.forEach { (name, value) -> addQueryParameter(name, value) }
                }.build()
                val request = Request.Builder().url(url).apply {
                    if (authenticated) header("Authorization", "Bearer $token")
                    if (etag != null && target.id == etagEngine) header("If-None-Match", etag)
                    if (body != null) post(body.toRequestBody("application/json; charset=utf-8".toMediaType()))
                }.build()
                val reply = try {
                    send(target.client, request).copy(engine = target.id)
                } catch (cause: IOException) {
                    // A pin mismatch can be another device at the same private address on this network.
                    if (pinMismatch(cause)) pinMismatches++
                    continue
                }
                // Another engine that does not know the phone yet (or left the group) is not an answer.
                if (reply.code == 401 && target.id.isNotEmpty()) continue@search
                if (!probe) {
                    if (target.id.isEmpty()) {
                        if (body == null) useEngine("", null)
                        if (endpoint != paths.current) paths.current = endpoint
                    } else if (body == null) useEngine(target.id, endpoint)
                }
                response = reply
                break@search
            }
        }
        if (response == null) {
            if (tried > 0 && pinMismatches == tried) throw AsbError.PinMismatch
            throw AsbError.Offline(hints.filter { it.kind != "lan" }.map { endpointLabel(it.kind) }.distinct())
        }
        when {
            response.code == 401 -> {
                if (authenticated && !probe) onNotPaired()
                throw AsbError.NotPaired
            }
            response.code == 429 -> throw AsbError.Throttled
            response.code == 404 && notFound != null -> throw AsbError.Server(notFound)
            response.code in 200..299 || (allowNotModified && response.code == 304) -> response
            else -> {
                val error = try { AsbJson.decodeFromString<ErrorReply>(response.body) }
                    catch (_: SerializationException) { ErrorReply() }
                var message = listOf(error.error, error.detail).filter { it.isNotBlank() }.joinToString(" ")
                    .ifEmpty { "ASB returned HTTP ${response.code}. Try again." }
                for (value in listOf(token, secret).filter { it.isNotEmpty() }) message = message.replace(value, "[removed]")
                throw AsbError.Server(message)
            }
        }
    }

    private suspend fun send(client: OkHttpClient, request: Request): Reply = suspendCancellableCoroutine { continuation ->
        val call = client.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, cause: IOException) {
                continuation.resumeWithException(cause)
            }

            override fun onResponse(call: Call, response: Response) {
                try {
                    val reply = response.use { Reply(it.code, it.body?.string().orEmpty(), it.header("ETag")) }
                    continuation.resume(reply)
                } catch (cause: IOException) {
                    continuation.resumeWithException(cause)
                }
            }
        })
    }

    private fun pinMismatch(cause: Throwable): Boolean =
        generateSequence(cause) { it.cause }.any { it is SSLPeerUnverifiedException || it is CertificateException }
}
