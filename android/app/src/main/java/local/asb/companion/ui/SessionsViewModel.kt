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
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
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
    /** The last failed action of a row, as the desktop row panel error. */
    val actionErrors: Map<String, String> = emptyMap(),
    /** The kind of endpoint that gave the last dashboard: lan, zerotier, or tailscale. */
    val path: String? = null,
    /** The engine of the dashboard on screen ("" is the paired PC); actions on its rows go to it. */
    val engine: String = "",
)

class SessionsViewModel(
    private val api: AsbApi,
    private val serverName: String,
    initiallyRevoked: Boolean = false,
    private val saveBaseline: (Map<String, Int>, String) -> Unit = { _, _ -> },
    private val notificationMutex: Mutex = Mutex(),
    private val loadBaseline: (String) -> Map<String, Int>? = { null },
    initialView: String = "comfortable",
    private val savePalette: (Palette) -> Unit = {},
    private val showLive: (Dashboard) -> Unit = {},
    /** Counts the default-network changes (AsbApp.networkChanges). */
    private val networkChanges: StateFlow<Long> = MutableStateFlow(0L),
) : ViewModel() {
    private val mutableState = MutableStateFlow(UiState(revoked = initiallyRevoked, view = initialView))
    val state: StateFlow<UiState> = mutableState.asStateFlow()
    var seenMessages: Set<Message>? = null
    /** The first visible session ("" at the top of the list), so a rotation or a return from Settings can show it again. */
    var anchorId: String? = null
    private val pollMutex = Mutex()
    private var etag: String? = null
    // Only the engine that gave the etag can answer 304 to it.
    private var etagEngine = ""
    private var offlineFailures = 0
    private var seenNetwork = networkChanges.value
    /**
     * At each poll start and after a network change the next good dashboard also reads hello, so new PC addresses
     * (ZeroTier selected later on the PC) and the engines of the machine group reach the phone.
     */
    private var learnAddresses = false
    private val readTimers = mutableMapOf<String, Job>()

    fun setFilter(filter: Filter) { mutableState.update { it.copy(filter = filter) } }
    fun setView(view: String) { mutableState.update { it.copy(view = view) } }
    fun dismissBanner() { mutableState.update { it.copy(banner = null) } }
    fun clearError() { mutableState.update { it.copy(lastError = null) } }

    suspend fun poll() {
        if (!pollMutex.tryLock()) return
        learnAddresses = true
        try {
            while (currentCoroutineContext().isActive && !state.value.revoked) {
                // Also a change while the screen was stopped: the user turns on ZeroTier in its own app.
                if (networkChanges.value != seenNetwork) {
                    seenNetwork = networkChanges.value
                    // A new VPN can need a few seconds, so the first offline retry comes after 3 s.
                    offlineFailures = -1
                    learnAddresses = true
                }
                val waitMs = notificationMutex.withLock { fetchDashboard() }
                if (state.value.revoked) return
                if (learnAddresses && !state.value.offline) {
                    learnAddresses = false
                    try { api.hello() } catch (_: AsbError) {}
                }
                withTimeoutOrNull(waitMs) { networkChanges.first { it != seenNetwork } }
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
            val name = row.machineName.ifEmpty { "another machine" }
            val banner = when {
                row.remote -> "On $name. Open it on $name."
                row.surface == "cli" -> "Runs in a terminal. ASB does not open CLI sessions."
                else -> "This session has no direct link."
            }
            mutableState.update { it.copy(banner = banner) }
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
                    val reply = api.action(id, apiAction, body, state.value.engine)
                    currentCoroutineContext().ensureActive()
                    if (action == "open") {
                        if (reply["opened"] != JsonPrimitive(true)) {
                            throw AsbError.Server("ASB did not open this session. Try again.")
                        }
                        mutableState.update { it.copy(banner = "Opened on ${api.engineName(state.value.engine) ?: serverName}") }
                    }
                    // The row stays busy until the board refresh below, so its controls never act on the old row.
                    // The snackbar of the old failure closes with the row's error.
                    mutableState.update { it.copy(openingIds = it.openingIds - id, actionErrors = it.actionErrors - id,
                        lastError = it.lastError.takeIf { e -> e != it.actionErrors[id] }) }
                    if (action == "mark-read") confirmRead(id)
                    etag = null
                    fetchDashboard()
                }
            } catch (cause: AsbError) {
                currentCoroutineContext().ensureActive()
                showError(cause)
                cause.message?.let { message -> mutableState.update { it.copy(actionErrors = it.actionErrors + (id to message)) } }
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
            val result = api.dashboard(if (force) null else etag, force, etagEngine)
            withContext(Dispatchers.Main.immediate) {
                ensureActive()
                val dashboard = when (result) {
                    is DashboardResult.Fetched -> result.dashboard
                    DashboardResult.NotModified -> state.value.dashboard
                }
                val engine = if (result is DashboardResult.Fetched) result.engine else state.value.engine
                dashboard?.let { saveBaseline(updateBaseline(loadBaseline(engine), it.threads), engine) }
                Palette.parse(dashboard?.palette)?.let(savePalette)
                dashboard?.let(showLive)
                if (result is DashboardResult.Fetched) {
                    etag = result.etag
                    etagEngine = result.engine
                }
                offlineFailures = 0
                mutableState.update { old ->
                    val before = old.dashboard?.threads.orEmpty().associate { it.id to it.state }
                    val now = dashboard?.threads.orEmpty().associate { it.id to it.state }
                    // A row that leaves the board or changes state loses its action error, as on the desktop.
                    val kept = old.actionErrors.filterKeys { id -> id in now && now[id] == before[id] }
                    old.copy(dashboard = dashboard, offline = false, path = api.endpoint?.kind, engine = engine,
                        // A poll that ends an offline state (a dashboard failure, or an action that could not reach
                        // ASB) clears its stale message; another action error stays for its snackbar until its row error goes.
                        lastError = if (old.offline || old.lastError in (old.actionErrors - kept.keys).values) null else old.lastError,
                        actionErrors = kept)
                }
                dashboard?.refreshIntervalMs?.takeIf { it == 2000L || it == 5000L } ?: 5000L
            }
        } catch (cause: AsbError) {
            withContext(Dispatchers.Main.immediate) {
                ensureActive()
                showError(cause, dashboardFailure = true)
                if (cause is AsbError.Offline) {
                    offlineFailures++
                    when (offlineFailures) { 0 -> 3000L; 1 -> 5000L; 2 -> 10000L; else -> 30000L }
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
