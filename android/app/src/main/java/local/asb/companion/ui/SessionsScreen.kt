package local.asb.companion.ui

import android.os.SystemClock
import android.provider.Settings
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListLayoutInfo
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.IntSize
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import local.asb.companion.R
import local.asb.companion.data.Message
import local.asb.companion.data.Provider
import local.asb.companion.data.Thread
import kotlin.math.pow

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    viewModel: SessionsViewModel,
    serverName: String,
    onSettings: () -> Unit,
    onPairAgain: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val lifecycleOwner = LocalLifecycleOwner.current
    val context = LocalContext.current
    val density = LocalDensity.current.density
    val snackbar = remember { SnackbarHostState() }
    val keyboard = LocalSoftwareKeyboardController.current
    val listState = rememberLazyListState()
    var showFilters by rememberSaveable { mutableStateOf(false) }
    var actionRowId by rememberSaveable { mutableStateOf<String?>(null) }
    var dismissedWarnings by rememberSaveable { mutableStateOf(mapOf<String, String>()) }
    var initialError by rememberSaveable { mutableStateOf<String?>(null) }
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val providerCenters = remember { mutableStateMapOf<String, Offset>() }
    var listOrigin by remember { mutableStateOf(Offset.Zero) }
    var listSize by remember { mutableStateOf(IntSize.Zero) }
    var flights by remember { mutableStateOf(emptyList<MessageFlight>()) }
    var highlights by remember { mutableStateOf(mapOf<String, Long>()) }
    var frameNanos by remember { mutableLongStateOf(System.nanoTime()) }
    var motionGeneration by remember { mutableLongStateOf(0L) }
    val threads = state.dashboard?.threads.orEmpty()
    val rows = remember(threads, state.filter) { filteredRows(threads, state.filter) }
    val rowsById = remember(rows) { rows.associateBy { it.id } }
    val rowIndexes = remember(rows) { rows.mapIndexed { index, row -> row.id to index }.toMap() }
    val currentRowIndexes by rememberUpdatedState(rowIndexes)
    val currentDensity by rememberUpdatedState(density)
    val visibleRows by remember(rowsById, listState) {
        derivedStateOf {
            listState.layoutInfo.visibleItemsInfo.mapNotNull { rowsById[it.key] }
        }
    }
    val clockIntervalMs = if (visibleRows.isEmpty()) 0L else clockInterval(visibleRows, nowMs) * 1000
    val providers = state.dashboard?.providers.orEmpty()
    val warnings = providers.filter {
        it.status == "warning" && it.message.isNotBlank() && dismissedWarnings[it.id] != it.message
    }
    val actionRow = threads.firstOrNull { it.id == actionRowId }
    val hasDrawerRows = threads.any { it.drawer && (state.filter.archived || !it.archived) }
    val workingOnly = state.filter.states == setOf("working")
    fun endpoint(id: String) = messageEndpoint(
        id, providerCenters, listOrigin, listSize, listState.layoutInfo, currentRowIndexes, currentDensity,
    )

    LaunchedEffect(viewModel, lifecycleOwner, state.revoked) {
        if (!state.revoked) lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            try {
                viewModel.poll()
            } finally {
                motionGeneration++
                flights = emptyList()
                highlights = emptyMap()
            }
        }
    }
    LaunchedEffect(lifecycleOwner, clockIntervalMs, visibleRows, state.revoked) {
        if (!state.revoked && clockIntervalMs > 0) {
            lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                while (isActive) {
                    nowMs = System.currentTimeMillis()
                    val resetDelay = visibleRows.map { it.limitResetsAtMs }.filter { it > nowMs }.minOrNull()?.minus(nowMs)
                    delay(minOf(clockIntervalMs, resetDelay ?: clockIntervalMs))
                }
            }
        }
    }
    LaunchedEffect(rowsById) {
        flights = flights.filter { it.message.from in rowsById && it.message.to in rowsById }
        highlights = highlights.filterKeys { it in rowsById }
        providerCenters.keys.filter { it !in rowsById }.forEach { providerCenters.remove(it) }
    }
    LaunchedEffect(viewModel, state.dashboard?.messages, rowsById, state.revoked) {
        if (state.revoked) return@LaunchedEffect
        val messages = state.dashboard?.messages ?: return@LaunchedEffect
        val (play, seen) = newMessages(messages, viewModel.seenMessages, rowsById.keys,
            System.currentTimeMillis(), MESSAGE_FLIGHT_LIMIT - flights.size)
        viewModel.seenMessages = seen
        if (play.isEmpty()) return@LaunchedEffect
        val generation = motionGeneration
        // New rows need one layout before their provider centers are available.
        withFrameNanos { }
        if (generation != motionGeneration ||
            !lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) || state.revoked) return@LaunchedEffect
        val reducedMotion = try {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        } catch (_: SecurityException) { false }
        val startedAt = System.nanoTime()
        val highlightEnd = SystemClock.uptimeMillis() + if (reducedMotion) 2000 else 160
        val added = mutableListOf<MessageFlight>()
        val lit = highlights.toMutableMap()
        for (message in play) {
            val start = endpoint(message.from) ?: continue
            val end = endpoint(message.to) ?: continue
            if (start.outside && end.outside) continue
            lit[message.from] = highlightEnd
            if (reducedMotion) lit[message.to] = highlightEnd
            else if (flights.size + added.size < MESSAGE_FLIGHT_LIMIT) added += MessageFlight(
                message, startedAt, messageDuration(((end.point - start.point).getDistance() / density).toDouble()),
                start.outside,
            )
        }
        highlights = lit
        if (added.isNotEmpty()) {
            frameNanos = startedAt
            flights = flights + added
        }
    }
    LaunchedEffect(highlights) {
        val next = highlights.values.minOrNull() ?: return@LaunchedEffect
        delay((next - SystemClock.uptimeMillis()).coerceAtLeast(1))
        highlights = highlights.filterValues { it > SystemClock.uptimeMillis() }
    }
    LaunchedEffect(flights.isNotEmpty()) {
        while (flights.isNotEmpty()) {
            withFrameNanos { frameNanos = it }
            flights = flights.map { flight ->
                if (flight.receiverOutside == null && flight.elapsedMs(frameNanos) >= flight.durationMs) {
                    flight.copy(receiverOutside = endpoint(flight.message.to)?.outside ?: true)
                } else flight
            }.filter { it.elapsedMs(frameNanos) < it.durationMs + if (it.receiverOutside == true) 720 else 420 }
        }
    }
    LaunchedEffect(providers) {
        dismissedWarnings = dismissedWarnings.filter { (id, text) ->
            providers.any { it.id == id && it.status == "warning" && it.message == text }
        }
    }
    LaunchedEffect(actionRowId, actionRow) {
        if (actionRowId != null && actionRow == null) actionRowId = null
    }
    LaunchedEffect(state.lastError) {
        state.lastError?.let { message ->
            if (state.dashboard == null) initialError = message
            snackbar.showSnackbar(message)
            if (viewModel.state.value.lastError == message) viewModel.clearError()
        }
    }
    LaunchedEffect(state.dashboard) {
        if (state.dashboard != null) initialError = null
    }
    LaunchedEffect(state.banner) {
        state.banner?.let { message ->
            snackbar.showSnackbar(message)
            if (viewModel.state.value.banner == message) viewModel.dismissBanner()
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("ASB", style = MaterialTheme.typography.titleLarge)
                        if (!state.revoked) Text(
                            "$serverName · ${if (state.offline) "Offline" else "Live"}",
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                },
                actions = {
                    if (!state.revoked) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(end = 8.dp)) {
                            IconButton(onClick = viewModel::refresh, enabled = !state.refreshing) {
                                if (state.refreshing) CircularProgressIndicator(
                                    modifier = Modifier.size(24.dp).semantics { contentDescription = "Refreshing" },
                                    strokeWidth = 2.dp,
                                ) else Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                            }
                            IconButton(onClick = onSettings) {
                                Icon(Icons.Default.Settings, contentDescription = "Settings")
                            }
                        }
                    }
                },
            )
        },
    ) { padding ->
        Box(
            modifier = Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding),
            contentAlignment = Alignment.TopCenter,
        ) {
            if (state.revoked) {
                Column(
                    modifier = Modifier.widthIn(max = 600.dp).fillMaxSize().padding(24.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        "This phone was removed from ASB. Pair again.",
                        style = MaterialTheme.typography.titleLarge,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    Spacer(Modifier.height(24.dp))
                    Button(onClick = onPairAgain) { Text("Pair again") }
                }
            } else Column(Modifier.widthIn(max = 840.dp).fillMaxSize().imePadding()) {
                OutlinedTextField(
                    value = state.filter.query,
                    onValueChange = { viewModel.setFilter(state.filter.copy(query = it)) },
                    placeholder = { Text("Search, or cl: / cx:") },
                    leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                    trailingIcon = {
                        if (state.filter.query.isNotEmpty()) IconButton(
                            onClick = { viewModel.setFilter(state.filter.copy(query = "")) },
                        ) { Icon(Icons.Default.Close, contentDescription = "Clear search") }
                    },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
                        .semantics { contentDescription = "Search sessions" },
                )
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    SessionChip("Pending", state.filter.pendingOnly, onClick = {
                        val selected = !state.filter.pendingOnly
                        viewModel.setFilter(state.filter.copy(
                            pendingOnly = selected,
                            drawerOnly = if (selected) false else state.filter.drawerOnly,
                        ))
                    })
                    SessionChip("Working", workingOnly, onClick = {
                        viewModel.setFilter(state.filter.copy(
                            states = if (workingOnly) STATES.toSet() else setOf("working"),
                        ))
                    })
                    SessionChip(
                        "Drawer", state.filter.drawerOnly,
                        modifier = Modifier.semantics {
                            contentDescription = if (hasDrawerRows) "Drawer, contains sessions" else "Drawer, empty"
                        },
                        dot = hasDrawerRows,
                        onClick = {
                            val selected = !state.filter.drawerOnly
                            viewModel.setFilter(state.filter.copy(
                                drawerOnly = selected,
                                pendingOnly = if (selected) false else state.filter.pendingOnly,
                            ))
                        },
                    )
                    SessionChip(
                        "Filters", state.filter.app != "all" || state.filter.archived ||
                            state.filter.states != STATES.toSet(),
                        onClick = { keyboard?.hide(); showFilters = true },
                    )
                }
                PullToRefreshBox(
                    isRefreshing = state.refreshing,
                    onRefresh = viewModel::refresh,
                    modifier = Modifier.fillMaxWidth().weight(1f).onGloballyPositioned {
                        listOrigin = it.positionInRoot()
                        listSize = it.size
                    },
                ) {
                    LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
                        warnings.forEach { provider ->
                            item(key = "warning:${provider.id}") {
                                ProviderWarning(provider) {
                                    dismissedWarnings = dismissedWarnings + (provider.id to provider.message)
                                }
                            }
                        }
                        if (rows.isEmpty()) item(key = "empty") {
                            Box(
                                modifier = Modifier.fillParentMaxSize().padding(24.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                if (state.dashboard == null && !state.offline && initialError == null && state.lastError == null) {
                                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                        CircularProgressIndicator(Modifier.semantics {
                                            contentDescription = "Loading sessions"
                                        })
                                        Spacer(Modifier.height(16.dp))
                                        Text("Loading sessions…")
                                    }
                                } else Text(
                                    when {
                                        state.dashboard == null -> initialError ?: state.lastError
                                            ?: "Could not load sessions. Check the PC and Wi-Fi, then refresh."
                                        threads.isEmpty() -> "No sessions found on the PC."
                                        else -> "No sessions match the search and filters."
                                    },
                                    style = MaterialTheme.typography.bodyLarge,
                                )
                            }
                        }
                        itemsIndexed(rows, key = { _, row -> row.id }) { index, row ->
                            if (index > 0 && rows[index - 1].pinned && !row.pinned) {
                                HorizontalDivider(Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                            }
                            SessionRow(
                                row = row,
                                drawer = state.filter.drawerOnly,
                                busy = row.id in state.busyIds,
                                nowMs = nowMs,
                                messageLit = row.id in highlights,
                                onProviderCenter = { center -> providerCenters[row.id] = center },
                                onOpen = { viewModel.action(row.id, "open") },
                                onActions = { keyboard?.hide(); actionRowId = row.id },
                            )
                        }
                        item(key = "bottom-space") { Spacer(Modifier.height(16.dp)) }
                    }
                    val messageColor = MaterialTheme.colorScheme.primary
                    Canvas(Modifier.matchParentSize().clipToBounds()) {
                        for (flight in flights) {
                            val start = endpoint(flight.message.from) ?: continue
                            val end = endpoint(flight.message.to) ?: continue
                            if (!start.outside || !end.outside) drawMessage(flight, frameNanos, start, end, messageColor)
                        }
                    }
                }
            }
        }
    }
    if (showFilters && !state.revoked) FilterSheet(
        filter = state.filter,
        onChange = viewModel::setFilter,
        onDismiss = { showFilters = false },
    )
    if (actionRow != null && !state.revoked) RowActionSheet(
        row = actionRow,
        busy = actionRow.id in state.busyIds,
        onDismiss = { actionRowId = null },
        onAction = { action -> actionRowId = null; viewModel.action(actionRow.id, action) },
    )
}

@Composable
private fun SessionChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    dot: Boolean = false,
) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        modifier = modifier.heightIn(min = 48.dp),
        leadingIcon = if (selected) ({ Icon(Icons.Default.Check, contentDescription = null, Modifier.size(18.dp)) }) else null,
        label = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(label)
                if (dot) Box(Modifier.size(6.dp).background(MaterialTheme.colorScheme.onSurface, CircleShape))
            }
        },
    )
}

@Composable
private fun ProviderWarning(provider: Provider, onDismiss: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 16.dp, end = 4.dp)) {
            Text(
                "Warning: ${provider.message}",
                color = MaterialTheme.colorScheme.onErrorContainer,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f).padding(vertical = 12.dp),
            )
            IconButton(onClick = onDismiss) {
                Icon(Icons.Default.Close, "Dismiss warning from ${provider.label.ifEmpty { provider.id }}")
            }
        }
    }
}

@Composable
private fun SessionRow(
    row: Thread, drawer: Boolean, busy: Boolean, nowMs: Long, messageLit: Boolean,
    onProviderCenter: (Offset) -> Unit, onOpen: () -> Unit, onActions: () -> Unit,
) {
    val left = limitLeft(row, nowMs)
    val limited = left > 0
    val indicator = attentionIndicator(row, drawer, nowMs)
    val state = stateLabel(row.state)
    val time = if (row.state == "working") workingDuration(row.workingSinceMs, nowMs) else idleAge(row.updatedAtMs, nowMs)
    val indicatorMeaning = when (indicator) {
        "question" -> if (row.actionRequired) "Action required on the PC" else "Question needs attention"
        "dot" -> when {
            row.failedAttention -> "Failed task, unread"
            row.completionAttention -> "Completed task, unread"
            else -> "Unread"
        }
        "discard" -> "Discard result is on"
        "stop" -> "Stopped"
        else -> ""
    }
    val description = listOf(
        row.title, row.projectName, state, if (limited) "Usage limit. Resets in ${spokenDuration(left)}" else time, indicatorMeaning,
        if (row.pinned) "Pinned" else "",
        if (row.drawer) "In the drawer" else "",
        row.sourceLabel.ifEmpty { row.providerLabel },
        if (!row.canOpen) "No direct link" else "",
        if (busy) "Opening" else "",
    ).filter { it.isNotBlank() }.joinToString(". ")
    val colors = MaterialTheme.colorScheme
    val titleColor = if (limited) colors.onSurfaceVariant else colors.onSurface
    val markerColor = remember(row.sourceColor, colors.surface, colors.primary) {
        sourceMarkerColor(row.sourceColor, colors.surface, colors.primary)
    }
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 88.dp)
            .combinedClickable(
                enabled = !busy,
                role = Role.Button,
                onClickLabel = if (row.canOpen) "Open on PC" else "Show link information",
                onLongClickLabel = "Session actions",
                onLongClick = onActions,
                onClick = onOpen,
            )
            .semantics(mergeDescendants = true) { contentDescription = description }
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(32.dp).onGloballyPositioned {
            onProviderCenter(it.positionInRoot() + Offset(it.size.width / 2f, it.size.height / 2f))
        }.clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
            Box(
                modifier = Modifier.fillMaxSize().graphicsLayer { alpha = if (limited) .4f else 1f }
                    .background(colors.surfaceContainerHigh, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(if (row.provider == "codex") "cx" else "cl", style = MaterialTheme.typography.labelMedium,
                    color = if (messageLit) colors.primary else colors.onSurfaceVariant)
            }
            if (row.sourceShowMarker && row.sourceCount > 1) Box(
                Modifier.align(Alignment.BottomStart).size(8.dp)
                    .background(markerColor, CircleShape)
                    .border(1.dp, colors.surface, CircleShape),
            )
        }
        Column(Modifier.weight(1f).clearAndSetSemantics { }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
                Text(row.title, style = MaterialTheme.typography.titleMedium, color = titleColor,
                    maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (row.pinned) Icon(PinIcon, contentDescription = null,
                    tint = colors.onSurfaceVariant, modifier = Modifier.padding(top = 3.dp).size(16.dp))
            }
            if (busy) Text("Opening…", style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
            else if (limited) Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Icon(painterResource(R.drawable.ic_schedule), contentDescription = null,
                    tint = colors.onSurfaceVariant, modifier = Modifier.size(12.dp))
                Text("Resets in ${durationText(left)}", style = MaterialTheme.typography.bodyMedium,
                    color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            else Row(verticalAlignment = Alignment.CenterVertically) {
                if (row.projectName.isNotBlank()) {
                    Text(row.projectName, style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    Text(" · ", style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
                }
                Text(listOf(state, time).filter { it.isNotEmpty() }.joinToString(" · "),
                    style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Box(Modifier.size(24.dp).clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
            when (indicator) {
                "question" -> Text("?", color = colors.primary, style = MaterialTheme.typography.titleLarge)
                "dot" -> Box(Modifier.size(8.dp).background(colors.primary, CircleShape))
                "discard" -> Box(Modifier.size(10.dp).border(1.5.dp, colors.onSurface, CircleShape))
                "stop" -> Box(Modifier.size(8.dp).background(colors.onSurfaceVariant, RoundedCornerShape(1.dp)))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FilterSheet(filter: Filter, onChange: (Filter) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(
            modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("Filters", style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.height(8.dp))
            Text("App", style = MaterialTheme.typography.titleMedium)
            listOf("all" to "All", "codex" to "Codex", "claude-desktop-code" to "Claude").forEach { (app, label) ->
                Row(
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                        .selectable(selected = filter.app == app, role = Role.RadioButton,
                            onClick = { onChange(filter.copy(app = app)) }),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    RadioButton(selected = filter.app == app, onClick = null)
                    Text(label, style = MaterialTheme.typography.bodyLarge)
                }
            }
            Spacer(Modifier.height(8.dp))
            Text("States", style = MaterialTheme.typography.titleMedium)
            STATES.forEach { state ->
                FilterCheckbox(stateLabel(state), state in filter.states) { checked ->
                    onChange(filter.copy(states = if (checked) filter.states + state else filter.states - state))
                }
            }
            Spacer(Modifier.height(8.dp))
            FilterCheckbox("Include archived", filter.archived) { onChange(filter.copy(archived = it)) }
            Button(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("Done") }
        }
    }
}

@Composable
private fun FilterCheckbox(label: String, checked: Boolean, onChecked: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
            .toggleable(value = checked, role = Role.Checkbox, onValueChange = onChecked),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Checkbox(checked = checked, onCheckedChange = null)
        Text(label, style = MaterialTheme.typography.bodyLarge)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RowActionSheet(row: Thread, busy: Boolean, onDismiss: () -> Unit, onAction: (String) -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(
            modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(row.title, style = MaterialTheme.typography.titleLarge, maxLines = 2,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 8.dp, vertical = 8.dp))
            val actions = (if (row.canOpen) listOf(MenuAction("Open on PC", "open")) else emptyList()) + rowMenuActions(row)
            actions.forEach { action ->
                TextButton(onClick = { onAction(action.action) }, enabled = !busy,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Text(action.label, modifier = Modifier.fillMaxWidth(), style = MaterialTheme.typography.bodyLarge)
                }
            }
        }
    }
}

private data class MessageFlight(
    val message: Message,
    val startedAtNanos: Long,
    val durationMs: Double,
    val senderOutside: Boolean,
    val receiverOutside: Boolean? = null,
) {
    fun elapsedMs(nowNanos: Long) = (nowNanos - startedAtNanos).coerceAtLeast(0) / 1_000_000.0
}

private data class MessageEndpoint(val point: Offset, val outside: Boolean)

private fun messageEndpoint(
    id: String,
    centers: Map<String, Offset>,
    origin: Offset,
    viewport: IntSize,
    layout: LazyListLayoutInfo,
    indexes: Map<String, Int>,
    density: Float,
): MessageEndpoint? {
    if (viewport.height <= 4 * density) return null
    val visible = layout.visibleItemsInfo.filter { it.key in indexes }
    val top = 2 * density
    val bottom = viewport.height - 2 * density
    if (visible.any { it.key == id }) {
        val center = centers[id]?.minus(origin) ?: return null
        val y = center.y.coerceIn(top, bottom)
        return MessageEndpoint(Offset(center.x, y), y != center.y)
    }
    val index = indexes[id] ?: return null
    val first = visible.firstNotNullOfOrNull { indexes[it.key] } ?: return null
    val x = visible.firstNotNullOfOrNull { centers[it.key]?.x?.minus(origin.x) } ?: return null
    return MessageEndpoint(Offset(x, if (index < first) top else bottom), true)
}

private fun DrawScope.drawMessage(
    flight: MessageFlight, nowNanos: Long, start: MessageEndpoint, end: MessageEndpoint, color: Color,
) {
    val elapsed = flight.elapsedMs(nowNanos)
    fun edge(point: Offset, ms: Double) {
        val alpha = minOf(1.0, ms / 120, 1 - (ms - 420) / 300).coerceAtLeast(0.0).toFloat()
        if (alpha > 0) drawRoundRect(
            color.copy(alpha = alpha), topLeft = point - Offset(9.dp.toPx(), 1.5.dp.toPx()),
            size = Size(18.dp.toPx(), 3.dp.toPx()), cornerRadius = CornerRadius(1.5.dp.toPx()),
        )
    }
    if (flight.senderOutside && start.outside && elapsed < 720) edge(start.point, elapsed)
    if (elapsed < flight.durationMs) {
        val controlDp = messageControl(
            (start.point.x / density).toDouble() to (start.point.y / density).toDouble(),
            (end.point.x / density).toDouble() to (end.point.y / density).toDouble(),
        )
        val control = Offset(controlDp.first.toFloat() * density, controlDp.second.toFloat() * density)
        fun point(time: Float): Offset {
            val t = if (time < .5f) 4 * time * time * time else 1 - (-2 * time + 2).pow(3) / 2
            val u = 1 - t
            return start.point * (u * u) + control * (2 * u * t) + end.point * (t * t)
        }
        val time = (elapsed / flight.durationMs).toFloat().coerceIn(0f, 1f)
        for (k in 1..8) {
            val first = time - (k - 1) * .025f
            if (first <= 0) break
            drawLine(
                color.copy(alpha = .7f * (1 - k / 9f)), point(first), point((time - k * .025f).coerceAtLeast(0f)),
                strokeWidth = 3.2.dp.toPx() * (1 - k / 9f), cap = StrokeCap.Round,
            )
        }
        val head = point(time)
        drawCircle(color.copy(alpha = .25f), 6.dp.toPx(), head)
        drawCircle(color, 3.dp.toPx(), head)
    } else if (flight.receiverOutside == true && end.outside) {
        edge(end.point, elapsed - flight.durationMs)
    } else if (flight.receiverOutside == false && !end.outside) {
        val time = ((elapsed - flight.durationMs) / 420).toFloat().coerceIn(0f, 1f)
        val progress = if (time == 1f) 1f else 1 - 2f.pow(-10 * time)
        drawCircle(color.copy(alpha = .85f * (1 - progress)), (5 + 8 * progress).dp.toPx(), end.point,
            style = Stroke(1.5.dp.toPx()))
    }
}

private fun sourceMarkerColor(value: String, surface: Color, fallback: Color): Color {
    val rgb = value.takeIf { it.matches(Regex("#[0-9a-fA-F]{6}")) }?.drop(1)?.toLongOrNull(16)
    val color = if (rgb == null) fallback else Color((0xff000000L or rgb).toInt())
    fun contrast(candidate: Color): Float {
        val a = candidate.luminance()
        val b = surface.luminance()
        return (maxOf(a, b) + 0.05f) / (minOf(a, b) + 0.05f)
    }
    if (contrast(color) >= 3f) return color
    val target = if (contrast(Color.White) > contrast(Color.Black)) Color.White else Color.Black
    // Adjust only the displayed marker so the configured color stays visible in either system theme.
    return (1..10).map { lerp(color, target, it / 10f) }.first { contrast(it) >= 3f }
}

private val PinIcon = ImageVector.Builder("Pin", 24.dp, 24.dp, 24f, 24f).apply {
    path(fill = SolidColor(Color.Black)) {
        moveTo(16f, 9f)
        verticalLineTo(4f)
        horizontalLineTo(17f)
        verticalLineTo(2f)
        horizontalLineTo(7f)
        verticalLineTo(4f)
        horizontalLineTo(8f)
        verticalLineTo(9f)
        lineTo(5f, 12f)
        verticalLineTo(14f)
        horizontalLineTo(11f)
        verticalLineTo(22f)
        horizontalLineTo(13f)
        verticalLineTo(14f)
        horizontalLineTo(19f)
        verticalLineTo(12f)
        close()
    }
}.build()
