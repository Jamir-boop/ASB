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
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Dashboard
import local.asb.companion.data.Endpoint
import local.asb.companion.data.ErrorReply
import local.asb.companion.data.Hello
import local.asb.companion.data.PairReply
import local.asb.companion.data.PairingInfo
import local.asb.companion.data.endpointLabel
import local.asb.companion.data.orderEndpoints
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
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

fun offlineMessage(overlays: List<String>): String =
    if (overlays.isEmpty()) "Could not reach ASB. Check the PC and Wi-Fi, then try again."
    else "Could not reach ASB. Check the PC and Wi-Fi. Away from home? Turn on ${overlays.joinToString(" or ")} on this phone."

/** The addresses of the PC and the one that answered last; the Store keeps them for the paired PC. */
interface Paths {
    var endpoints: List<Endpoint>
    var current: Endpoint?
}

class MemoryPaths(override var endpoints: List<Endpoint>, override var current: Endpoint? = null) : Paths

sealed interface DashboardResult {
    data class Fetched(val dashboard: Dashboard, val etag: String?) : DashboardResult
    data object NotModified : DashboardResult
}

/**
 * A GET tries the current endpoint, then the others in order, and the first that answers becomes current.
 * A POST goes only to one endpoint and is never sent again to another one, so an action cannot run twice.
 */
class AsbApi(
    private val paths: Paths,
    private val port: Int,
    fingerprint: String,
    private val token: String = "",
    private val onNotPaired: () -> Unit = {},
) {
    private val client = pinnedClient(fingerprint)

    /** The endpoint that answered last, or null before the first answer on this network. */
    val endpoint: Endpoint? get() = paths.current

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
        val reply = decode<Hello>(request("hello").body)
        if (reply.api != 1 || !reply.deviceId.matches(Regex("[0-9a-f]{12}"))) invalidReply()
        val fresh = orderEndpoints(reply.addresses)
        if (fresh.isNotEmpty() && fresh != paths.endpoints) {
            paths.endpoints = fresh
            if (paths.current !in fresh) paths.current = null
        }
        return reply
    }

    suspend fun dashboard(etag: String? = null, force: Boolean = false): DashboardResult {
        val response = request("dashboard", etag = etag, force = force, allowNotModified = true)
        return if (response.code == 304) DashboardResult.NotModified
        else DashboardResult.Fetched(decode<Dashboard>(response.body), response.etag)
    }

    suspend fun action(id: String, action: String, body: String = "{}"): JsonObject {
        if (id.isEmpty() || id == "." || id == "..") throw AsbError.Server("Invalid session ID.")
        if (action !in setOf("open", "mark-read", "mark-unread", "pin", "unpin", "move-pin",
            "discard-result", "keep-result", "drawer-in", "drawer-out")) throw AsbError.Server("Invalid ASB action.")
        val parsed = try { AsbJson.parseToJsonElement(body) } catch (_: SerializationException) { null }
        if (parsed !is JsonObject) throw AsbError.Server("Invalid action body.")
        return decode<JsonObject>(request("threads", id, action, body = body).body)
    }

    suspend fun setPersistentUnread(value: Boolean) {
        val body = buildJsonObject { put("persistentUnread", value) }
        request("settings", "unread", body = body.toString())
    }

    private data class Reply(val code: Int, val body: String, val etag: String?)

    private suspend fun request(
        vararg segments: String,
        body: String? = null,
        authenticated: Boolean = true,
        etag: String? = null,
        force: Boolean = false,
        allowNotModified: Boolean = false,
        secret: String = "",
    ): Reply = withContext(Dispatchers.IO) {
        val endpoints = paths.endpoints
        val first = paths.current?.takeIf { it in endpoints } ?: endpoints.firstOrNull()
            ?: throw AsbError.Offline()
        val order = if (body == null) listOf(first) + (endpoints - first) else listOf(first)
        var pinMismatches = 0
        var response: Reply? = null
        for (endpoint in order) {
            ensureActive()
            val url = HttpUrl.Builder().scheme("https").host(endpoint.host).port(port).addPathSegments("phone/v1").apply {
                segments.forEach { addPathSegment(it) }
                if (force) addQueryParameter("force", "1")
            }.build()
            val request = Request.Builder().url(url).apply {
                if (authenticated) header("Authorization", "Bearer $token")
                if (etag != null) header("If-None-Match", etag)
                if (body != null) post(body.toRequestBody("application/json; charset=utf-8".toMediaType()))
            }.build()
            try {
                response = send(request)
            } catch (cause: IOException) {
                // A pin mismatch can be another device at the same private address on this network.
                if (pinMismatch(cause)) pinMismatches++
                continue
            }
            if (endpoint != paths.current) paths.current = endpoint
            break
        }
        if (response == null) {
            if (pinMismatches == order.size) throw AsbError.PinMismatch
            throw AsbError.Offline(endpoints.filter { it.kind != "lan" }.map { endpointLabel(it.kind) }.distinct())
        }
        when {
            response.code == 401 -> {
                if (authenticated) onNotPaired()
                throw AsbError.NotPaired
            }
            response.code == 429 -> throw AsbError.Throttled
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

    private suspend fun send(request: Request): Reply = suspendCancellableCoroutine { continuation ->
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
