package local.asb.companion.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

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
)

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
