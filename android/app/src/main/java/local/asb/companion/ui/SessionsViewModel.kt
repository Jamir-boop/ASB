package local.asb.companion.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import local.asb.companion.data.Dashboard
import local.asb.companion.data.Message
import local.asb.companion.data.Palette
import local.asb.companion.net.AsbApi
import local.asb.companion.net.AsbError
import local.asb.companion.net.DashboardResult
import local.asb.companion.notify.update as updateBaseline

data class UiState(
    val dashboard: Dashboard? = null,
    val filter: Filter = Filter(),
    val offline: Boolean = false,
    val banner: String? = null,
    val busyIds: Set<String> = emptySet(),
    val lastError: String? = null,
    val revoked: Boolean = false,
    val refreshing: Boolean = false,
    val view: String = "comfortable",
    val openingIds: Set<String> = emptySet(),
    val readConfirmedIds: Set<String> = emptySet(),
    /** The kind of endpoint that gave the last dashboard: lan, zerotier, or tailscale. */
    val path: String? = null,
)

class SessionsViewModel(
    private val api: AsbApi,
    private val serverName: String,
    initiallyRevoked: Boolean = false,
    private val saveBaseline: (Map<String, Int>) -> Unit = {},
    private val notificationMutex: Mutex = Mutex(),
    private val loadBaseline: () -> Map<String, Int>? = { null },
    initialView: String = "comfortable",
    private val savePalette: (Palette) -> Unit = {},
    private val showLive: (Dashboard) -> Unit = {},
) : ViewModel() {
    private val mutableState = MutableStateFlow(UiState(revoked = initiallyRevoked, view = initialView))
    val state: StateFlow<UiState> = mutableState.asStateFlow()
    var seenMessages: Set<Message>? = null
    /** The first visible session, so a rotation or a return from Settings can show it again. */
    var anchorId: String? = null
    private val pollMutex = Mutex()
    private var etag: String? = null
    private var offlineFailures = 0
    private val readTimers = mutableMapOf<String, Job>()

    fun setFilter(filter: Filter) { mutableState.update { it.copy(filter = filter) } }
    fun setView(view: String) { mutableState.update { it.copy(view = view) } }
    fun dismissBanner() { mutableState.update { it.copy(banner = null) } }
    fun clearError() { mutableState.update { it.copy(lastError = null) } }

    suspend fun poll() {
        if (!pollMutex.tryLock()) return
        try {
            while (currentCoroutineContext().isActive && !state.value.revoked) {
                val waitMs = notificationMutex.withLock { fetchDashboard() }
                if (state.value.revoked) return
                delay(waitMs)
            }
        } finally {
            pollMutex.unlock()
        }
    }

    fun refresh() {
        if (state.value.refreshing || state.value.revoked) return
        mutableState.update { it.copy(refreshing = true) }
        viewModelScope.launch {
            try {
                notificationMutex.withLock { fetchDashboard(force = true) }
            } finally {
                mutableState.update { it.copy(refreshing = false) }
            }
        }
    }

    fun action(id: String, action: String) {
        if (state.value.revoked || id in state.value.busyIds) return
        val row = state.value.dashboard?.threads?.find { it.id == id } ?: return
        if (action == "open" && !row.canOpen) {
            mutableState.update { it.copy(banner = "This session has no direct link.") }
            return
        }
        mutableState.update { it.copy(busyIds = it.busyIds + id,
            openingIds = if (action == "open") it.openingIds + id else it.openingIds) }
        viewModelScope.launch {
            try {
                notificationMutex.withLock {
                    if (state.value.revoked) return@withLock
                    var apiAction = action
                    var body = "{}"
                    if (action == "pin-up" || action == "pin-down") {
                        val direction = if (action == "pin-up") "up" else "down"
                        val visible = filteredRows(state.value.dashboard?.threads.orEmpty(), state.value.filter)
                        body = pinMoveBody(visible, id, direction) ?: run {
                            mutableState.update { it.copy(banner = if (direction == "up") "Already first" else "Already last") }
                            return@withLock
                        }
                        apiAction = "move-pin"
                    }
                    val reply = api.action(id, apiAction, body)
                    currentCoroutineContext().ensureActive()
                    if (action == "open") {
                        if (reply["opened"] != JsonPrimitive(true)) {
                            throw AsbError.Server("ASB did not open this session. Try again.")
                        }
                        mutableState.update { it.copy(banner = "Opened on $serverName") }
                    }
                    mutableState.update { it.copy(busyIds = it.busyIds - id, openingIds = it.openingIds - id) }
                    if (action == "mark-read") confirmRead(id)
                    etag = null
                    fetchDashboard()
                }
            } catch (cause: AsbError) {
                currentCoroutineContext().ensureActive()
                showError(cause)
            } finally {
                mutableState.update { it.copy(busyIds = it.busyIds - id, openingIds = it.openingIds - id) }
            }
        }
    }

    // The card corner shows a check for 1.6 s after a successful Read, as on the desktop.
    private fun confirmRead(id: String) {
        mutableState.update { it.copy(readConfirmedIds = it.readConfirmedIds + id) }
        readTimers.remove(id)?.cancel()
        readTimers[id] = viewModelScope.launch {
            delay(1600)
            readTimers.remove(id)
            mutableState.update { it.copy(readConfirmedIds = it.readConfirmedIds - id) }
        }
    }

    private suspend fun fetchDashboard(force: Boolean = false): Long {
        if (state.value.revoked) return 5000L
        return try {
            val result = api.dashboard(if (force) null else etag, force)
            withContext(Dispatchers.Main.immediate) {
                ensureActive()
                val dashboard = when (result) {
                    is DashboardResult.Fetched -> result.dashboard
                    DashboardResult.NotModified -> state.value.dashboard
                }
                dashboard?.let { saveBaseline(updateBaseline(loadBaseline(), it.threads)) }
                Palette.parse(dashboard?.palette)?.let(savePalette)
                dashboard?.let(showLive)
                if (result is DashboardResult.Fetched) etag = result.etag
                offlineFailures = 0
                mutableState.update { it.copy(dashboard = dashboard, offline = false, lastError = null, path = api.endpoint?.kind) }
                dashboard?.refreshIntervalMs?.takeIf { it == 2000L || it == 5000L } ?: 5000L
            }
        } catch (cause: AsbError) {
            withContext(Dispatchers.Main.immediate) {
                ensureActive()
                showError(cause, dashboardFailure = true)
                if (cause is AsbError.Offline) {
                    offlineFailures++
                    when (offlineFailures) { 1 -> 5000L; 2 -> 10000L; else -> 30000L }
                } else 5000L
            }
        }
    }

    private fun showError(cause: AsbError, dashboardFailure: Boolean = false) {
        mutableState.update {
            it.copy(offline = it.offline || dashboardFailure || cause is AsbError.Offline || cause === AsbError.PinMismatch,
                revoked = it.revoked || cause === AsbError.NotPaired,
                lastError = cause.message)
        }
    }
}
