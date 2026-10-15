package local.asb.companion.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonTransformingSerializer

val AsbJson = Json { ignoreUnknownKeys = true }

@Serializable
data class Dashboard(
    val generatedAtMs: Long = 0,
    val performance: JsonObject = JsonObject(emptyMap()),
    val persistentUnread: Boolean = true,
    val pinnedOrder: List<String> = emptyList(),
    val providers: List<Provider> = emptyList(),
    val refreshIntervalMs: Long = 5000,
    val summary: JsonObject = JsonObject(emptyMap()),
    val threads: List<Thread> = emptyList(),
    @Serializable(with = MessageListSerializer::class)
    val messages: List<Message> = emptyList(),
)

@Serializable
data class Message(val from: String = "", val to: String = "", val atMs: Long = 0)

private object MessageListSerializer : JsonTransformingSerializer<List<Message>>(ListSerializer(Message.serializer())) {
    private val number = Regex("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")

    override fun transformDeserialize(element: JsonElement): JsonElement = JsonArray(
        (element as? JsonArray).orEmpty().mapNotNull { entry ->
            val message = entry as? JsonObject ?: return@mapNotNull null
            if ((message["from"] as? JsonPrimitive)?.isString != true ||
                (message["to"] as? JsonPrimitive)?.isString != true) return@mapNotNull null
            val at = message["atMs"] as? JsonPrimitive ?: return@mapNotNull null
            if (at.isString || !number.matches(at.content)) return@mapNotNull null
            // Message identity uses exact whole milliseconds, so no rounding or clipping is allowed.
            val milliseconds = try { at.content.toBigDecimalOrNull()?.longValueExact() }
                catch (_: ArithmeticException) { null } ?: return@mapNotNull null
            JsonObject(message + ("atMs" to JsonPrimitive(milliseconds)))
        }
    )
}

@Serializable
data class Thread(
    val id: String = "",
    val externalId: String = "",
    val sourceId: String = "",
    val sourceLabel: String = "",
    val sourceNumber: Int = 0,
    val sourceCount: Int = 0,
    val sourceColor: String = "",
    val sourceShowMarker: Boolean = true,
    val provider: String = "",
    val providerLabel: String = "",
    val title: String = "",
    val cwd: String = "",
    val projectName: String = "",
    val archived: Boolean = false,
    val updatedAtMs: Long = 0,
    val subagentCount: Int = 0,
    val state: String = "unknown",
    val reason: String = "",
    val workingSinceMs: Long = 0,
    val nativeUnread: Boolean? = null,
    val readStatus: String = "",
    val questionPending: Boolean = false,
    val actionRequired: Boolean = false,
    val lastOutcome: String = "",
    val failedAtMs: Long = 0,
    val completionAtMs: Long = 0,
    val limitResetsAtMs: Long = 0,
    val canOpen: Boolean = false,
    val appDeepLink: String = "",
    val discardResult: Boolean = false,
    val pinIndex: Int = -1,
    val pinned: Boolean = false,
    val manualUnread: Boolean = false,
    val questionAttention: Boolean = false,
    val nativeAttention: Boolean = false,
    val failedAttention: Boolean = false,
    val completionAttention: Boolean = false,
    val retainedUnread: Boolean = false,
    val retainedUnreadSource: String = "",
    val drawer: Boolean = false,
    val unread: Boolean = false,
    val pending: Boolean = false,
    val pendingSource: String = "",
)

@Serializable
data class Provider(
    val id: String = "",
    val label: String = "",
    val status: String = "",
    val message: String = "",
)

@Serializable
data class Hello(
    val api: Int = 0,
    val asbVersion: String = "",
    val deviceId: String = "",
    val serverName: String = "",
)

@Serializable
data class PairReply(
    val deviceId: String = "",
    val token: String = "",
    val serverName: String = "",
    val asbVersion: String = "",
    val api: Int = 0,
)

@Serializable
data class ErrorReply(val error: String = "", val detail: String = "")
