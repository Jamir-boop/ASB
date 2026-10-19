package local.asb.companion.ui

import android.os.SystemClock
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.unit.Dp
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.IndicationNodeFactory
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.key
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.node.DelegatableNode
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import local.asb.companion.data.Palette
import local.asb.companion.data.displaySourceColor
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
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
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
import local.asb.companion.data.Store
import local.asb.companion.data.Thread
import local.asb.companion.data.endpointLabel
import kotlin.math.pow
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import local.asb.companion.data.edgeColor
import local.asb.companion.data.mixColor
import local.asb.companion.data.luminance
import local.asb.companion.data.readableColor
import kotlin.math.roundToInt

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    viewModel: SessionsViewModel,
    serverName: String,
    onSettings: () -> Unit,
    onPairAgain: () -> Unit,
) = BoxWithConstraints {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val lifecycleOwner = LocalLifecycleOwner.current
    val context = LocalContext.current
    val density = LocalDensity.current.density
    val fontScale = LocalDensity.current.fontScale
    val snackbar = remember { SnackbarHostState() }
    val keyboard = LocalSoftwareKeyboardController.current
    // Landscape and other wide windows use the desktop Column Flow.
    val flow = maxWidth >= 600.dp
    var searchOpened by rememberSaveable { mutableStateOf(false) }
    var focusSearch by remember { mutableStateOf(false) }
    val searching = searchOpen(searchOpened, state.filter.query)
    val searchFocus = remember { FocusRequester() }
    var discMenu by remember { mutableStateOf(false) }
    val comfortable = state.view != "compact"
    val rowGap = if (comfortable) COMFORTABLE_CARD_GAP else 0
    val rowHeight = if (comfortable) comfortableCardHeight(fontScale) else compactRowHeight(fontScale)
    var showFilters by rememberSaveable { mutableStateOf(false) }
    // The inspector row ID and the long-press point in window pixels. A rotation closes it.
    var inspector by remember { mutableStateOf<Pair<String, Offset>?>(null) }
    val store = remember(context) { Store(context) }
    var dismissedWarnings by remember { mutableStateOf(store.dismissedWarnings) }
    fun dismissWarning(provider: Provider) {
        dismissedWarnings = dismissedWarnings + (provider.id to provider.message)
        store.dismissedWarnings = dismissedWarnings
    }
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
    val providers = state.dashboard?.providers.orEmpty()
    val warnings = providers.filter {
        it.status == "warning" && it.message.isNotBlank() && dismissedWarnings[it.id] != it.message
    }
    val packing = remember(rows, listSize, rowHeight, rowGap, density) {
        packColumns(rows, (listSize.width / density).toInt(), (listSize.height / density).toInt(), rowHeight = rowHeight,
            minGap = minOf(rowGap, COMFORTABLE_MIN_CARD_GAP).toFloat(), maxGap = rowGap.toFloat())
    }
    val currentPacking by rememberUpdatedState(packing)
    // A new list state per layout: a view change or a repack shows the new layout at once, with no card motion.
    // It starts at the first session that was visible before, so rotation keeps that session in view.
    // A list that was at the top (anchor "") or a missing anchor starts at the top, so warnings and moved rows stay in view.
    // The number of one-column items before the first row: the warnings and the "empty" item.
    val lead = warnings.size + if (rows.isEmpty()) 1 else 0
    val listState = remember(flow, state.view, if (flow) packing.columns to packing.capacity else null) {
        LazyListState(startIndex(rows.indexOfFirst { it.id == viewModel.anchorId }, flow, packing.capacity, lead))
    }
    // The keys of the one-column list, in the same order as its items.
    val listKeys = remember(warnings, rows) {
        buildList<Any> {
            warnings.forEach { add("warning:${it.id}") }
            if (rows.isEmpty()) add("empty")
            rows.forEach { add(it.id) }
            add("bottom-space")
        }
    }
    // An empty list goes to the top, so a warning that may explain it shows.
    if (!flow) KeepPositionOnChange(listState, listKeys, top = rows.isEmpty(), lead = lead)
    LaunchedEffect(listState, flow) {
        snapshotFlow {
            if (listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset == 0) ""
            else if (flow) currentPacking.parts.getOrNull(listState.firstVisibleItemIndex)?.firstOrNull()?.id
            else listState.layoutInfo.visibleItemsInfo.firstOrNull { it.key in currentRowIndexes }?.key as? String
        }.collect { id -> if (id != null) viewModel.anchorId = id }
    }
    val visibleRows by remember(rowsById, listState, flow, packing) {
        derivedStateOf {
            if (flow) listState.layoutInfo.visibleItemsInfo.flatMap { packing.parts.getOrNull(it.index).orEmpty() }
            else listState.layoutInfo.visibleItemsInfo.mapNotNull { rowsById[it.key] }
        }
    }
    val inspectorRow = inspector?.let { (id, _) -> rowsById[id] }
    // The inspector shows its row's timer even when the row is off screen.
    val clockRows = visibleRows + listOfNotNull(inspectorRow)
    val clockIntervalMs = if (clockRows.isEmpty()) 0L else clockInterval(clockRows, nowMs) * 1000
    val hasDrawerRows = threads.any { it.drawer && (state.filter.archived || !it.archived) }
    val workingOnly = state.filter.states == setOf("working")
    fun endpoint(id: String) = if (flow) flowEndpoint(
        id, providerCenters, listOrigin, listSize, listState.layoutInfo, currentRowIndexes, currentPacking.capacity,
        rowHeight * currentDensity, currentPacking.gap * currentDensity, currentDensity,
    ) else messageEndpoint(
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
    LaunchedEffect(lifecycleOwner, clockIntervalMs, clockRows, state.revoked) {
        if (!state.revoked && clockIntervalMs > 0) {
            lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                while (isActive) {
                    nowMs = System.currentTimeMillis()
                    val resetDelay = clockRows.map { it.limitResetsAtMs }.filter { it > nowMs }.minOrNull()?.minus(nowMs)
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
    LaunchedEffect(focusSearch) {
        if (focusSearch) {
            searchFocus.requestFocus()
            keyboard?.show()
            focusSearch = false
        }
    }
    fun closeSearch() {
        keyboard?.hide()
        searchOpened = false
        viewModel.setFilter(state.filter.copy(query = ""))
    }
    BackHandler(enabled = !state.revoked && if (flow) state.filter.query.isNotEmpty() else searching) { closeSearch() }
    LaunchedEffect(inspector, inspectorRow) {
        if (inspector != null && inspectorRow == null) inspector = null
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

    @Composable
    fun card(row: Thread, modifier: Modifier) = SessionCard(
        row = row,
        comfortable = comfortable,
        drawerView = state.filter.drawerOnly,
        busy = row.id in state.busyIds,
        opening = row.id in state.openingIds,
        confirmed = row.id in state.readConfirmedIds,
        nowMs = nowMs,
        messageLit = row.id in highlights,
        onProviderCenter = { center -> providerCenters[row.id] = center },
        onOpen = { viewModel.action(row.id, "open") },
        onActions = { point -> keyboard?.hide(); inspector = row.id to point },
        onCorner = { action -> viewModel.action(row.id, action) },
        modifier = modifier,
    )

    @Composable
    fun emptyState(modifier: Modifier) = Box(modifier.padding(24.dp), contentAlignment = Alignment.Center) {
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

    @Composable
    fun searchField(modifier: Modifier, height: Dp, placeholder: String) {
        val palette = LocalPalette.current
        val muted = hexColor(palette.muted)
        BasicTextField(
            value = state.filter.query,
            onValueChange = { viewModel.setFilter(state.filter.copy(query = it)) },
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyMedium.copy(color = hexColor(palette.text)),
            cursorBrush = SolidColor(hexColor(palette.accent)),
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
            modifier = modifier.heightIn(min = height).focusRequester(searchFocus)
                .semantics { contentDescription = "Search sessions" },
        ) { inner ->
            Row(
                // A minimum height, so large text makes the field taller and does not clip.
                modifier = Modifier.fillMaxWidth().heightIn(min = height)
                    .border(1.dp, hexColor(controlOutline(palette)), CircleShape)
                    .padding(start = 12.dp, end = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Default.Search, contentDescription = null, tint = muted, modifier = Modifier.size(18.dp))
                Box(Modifier.weight(1f)) {
                    if (state.filter.query.isEmpty()) Text(placeholder, style = MaterialTheme.typography.bodyMedium,
                        color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    inner()
                }
                // Portrait closes search mode; the always-visible Column Flow field only clears its query.
                if (!flow || state.filter.query.isNotEmpty()) Box(
                    Modifier.size(height - 4.dp).wrapContentSize(unbounded = true).size(48.dp).clip(CircleShape)
                        .clickable(role = Role.Button) {
                            if (flow) viewModel.setFilter(state.filter.copy(query = "")) else closeSearch()
                        }.semantics { contentDescription = if (flow) "Clear search" else "Close search" },
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Default.Close, contentDescription = null, modifier = Modifier.size(20.dp)) }
            }
        }
    }

    @Composable
    fun pills(modifier: Modifier) {
        val scroll = rememberScrollState()
        Row(
            // The row fades out over 22 dp at its end while more pills are past that edge.
            modifier = modifier.graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen).drawWithContent {
                drawContent()
                if (scroll.canScrollForward) drawRect(
                    Brush.horizontalGradient(listOf(Color.Black, Color.Transparent), size.width - 22.dp.toPx(), size.width),
                    topLeft = Offset(size.width - 22.dp.toPx(), 0f),
                    blendMode = BlendMode.DstIn,
                )
            }.horizontalScroll(scroll).padding(end = 18.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
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
                icon = FiltersIcon,
                onClick = { keyboard?.hide(); showFilters = true },
            )
        }
    }

    @Composable
    fun disc(connection: String) = Box {
        val palette = LocalPalette.current
        // The disc is 24 dp in the row; its touch area is 48 dp around it, as the card corner controls.
        Box(
            Modifier.size(24.dp).wrapContentSize(unbounded = true).size(48.dp).clip(CircleShape)
                .combinedClickable(
                    role = Role.Button,
                    onClickLabel = "Show connection",
                    onLongClickLabel = "Show connection",
                    onLongClick = { discMenu = true },
                    onClick = { discMenu = true },
                ).semantics { contentDescription = "ASB connection: $connection" },
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(24.dp)) {
                Image(painterResource(R.drawable.ic_launcher_disc), contentDescription = null, modifier = Modifier.fillMaxSize())
                // A 9 dp status dot with a 2 dp ring in the background color, 1 dp past the disc corner.
                // Live is a filled dot and Offline a hollow ring, so the state does not depend on color only.
                Box(
                    Modifier.align(Alignment.BottomEnd).offset(3.dp, 3.dp).size(13.dp)
                        .background(hexColor(palette.background), CircleShape).padding(2.dp)
                        .then(if (state.offline) Modifier.border(2.dp, hexColor(palette.muted), CircleShape)
                            else Modifier.background(hexColor(palette.success), CircleShape)),
                )
            }
        }
        val density = LocalDensity.current
        DropdownMenu(expanded = discMenu, onDismissRequest = { discMenu = false }) {
            CompositionLocalProvider(LocalDensity provides density) {
                Text(connection, style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp).widthIn(max = 280.dp))
                DropdownMenuItem(
                    text = { Text("Refresh") },
                    leadingIcon = { Icon(Icons.Default.Refresh, contentDescription = null) },
                    enabled = !state.refreshing,
                    onClick = { discMenu = false; viewModel.refresh() },
                )
            }
        }
    }

    @Composable
    fun topBar() {
        val palette = LocalPalette.current
        val connection = connectionText(serverName, state.offline, state.path?.let(::endpointLabel))
        val settings: @Composable () -> Unit = {
            IconButton(onClick = onSettings) { Icon(Icons.Default.Settings, contentDescription = "Settings") }
        }
        Column(Modifier.fillMaxWidth().background(hexColor(palette.background))
            .windowInsetsPadding(SafeTopBarInsets)) {
            if (flow) Row(
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 12.dp, end = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                disc(connection)
                val word = if (state.offline) "Offline" else "Live"
                val start = connection.indexOf(word, serverName.length)
                Text(
                    buildAnnotatedString {
                        append(connection)
                        if (start >= 0) addStyle(SpanStyle(color = hexColor(palette.text)), start, start + word.length)
                    },
                    color = hexColor(palette.muted), fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 160.dp).clearAndSetSemantics { },
                )
                searchField(Modifier.width(150.dp), 36.dp, "Search")
                pills(Modifier.weight(1f))
                settings()
            } else Row(
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = 12.dp, end = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (searching) searchField(Modifier.weight(1f), 40.dp, "Search, or cl: / cx:")
                else {
                    disc(connection)
                    pills(Modifier.weight(1f))
                    IconButton(onClick = { searchOpened = true; focusSearch = true }) {
                        Icon(Icons.Default.Search, contentDescription = "Search")
                    }
                }
                settings()
            }
            HorizontalDivider(thickness = 1.dp, color = hexColor(palette.divider))
        }
    }

    Scaffold(
        contentWindowInsets = SafeContentInsets,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = { if (!state.revoked) topBar() },
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
            } else Column(Modifier.then(if (flow) Modifier else Modifier.widthIn(max = 840.dp)).fillMaxSize().imePadding()) {
                if (flow) warnings.forEach { provider ->
                    ProviderWarning(provider) { dismissWarning(provider) }
                }
                PullToRefreshBox(
                    isRefreshing = state.refreshing,
                    onRefresh = viewModel::refresh,
                    modifier = Modifier.fillMaxWidth().weight(1f).onGloballyPositioned {
                        listOrigin = it.positionInRoot()
                        listSize = it.size
                    },
                ) {
                    key(listState) { if (flow) {
                        val divider = MaterialTheme.colorScheme.outline
                        if (rows.isEmpty()) emptyState(Modifier.fillMaxSize())
                        else if (listSize.height > 0) LazyRow(state = listState, modifier = Modifier.fillMaxSize()) {
                            itemsIndexed(packing.parts, key = { index, _ -> index }) { index, part ->
                                // Columns never scroll, so each column always shows its first card.
                                val columnState = rememberLazyListState()
                                KeepPositionOnChange(columnState, remember(part) { part.map { it.id } }, top = true)
                                // Columns share the visible width equally; a 1 dp divider in the palette color separates them.
                                LazyColumn(
                                    state = columnState,
                                    userScrollEnabled = false,
                                    verticalArrangement = Arrangement.spacedBy(packing.gap.dp),
                                    modifier = Modifier.fillParentMaxWidth(1f / packing.columns).fillParentMaxHeight()
                                        .drawBehind {
                                            if (index > 0) drawLine(divider, Offset.Zero, Offset(0f, size.height), 1.dp.toPx())
                                        },
                                ) {
                                    items(part, key = { it.id }) { row -> card(row, Modifier.animateItem(CardFade, CardPlacement, null)) }
                                }
                            }
                        }
                    } else LazyColumn(state = listState, modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(rowGap.dp)) {
                        warnings.forEach { provider ->
                            item(key = "warning:${provider.id}") {
                                ProviderWarning(provider) { dismissWarning(provider) }
                            }
                        }
                        if (rows.isEmpty()) item(key = "empty") { emptyState(Modifier.fillParentMaxSize()) }
                        itemsIndexed(rows, key = { _, row -> row.id }) { index, row ->
                            Column(Modifier.animateItem(CardFade, CardPlacement, null)) {
                                if (index > 0 && rows[index - 1].pinned && !row.pinned) {
                                    HorizontalDivider(Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                                }
                                card(row, Modifier.padding(horizontal = 8.dp))
                            }
                        }
                        item(key = "bottom-space") { Spacer(Modifier.height(16.dp)) }
                    } }
                    val messageColor = MaterialTheme.colorScheme.primary
                    Canvas(Modifier.matchParentSize().clipToBounds()) {
                        for (flight in flights) {
                            val start = endpoint(flight.message.from) ?: continue
                            val end = endpoint(flight.message.to) ?: continue
                            if (!start.outside || !end.outside) drawMessage(flight, frameNanos, start, end, messageColor, flow)
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
    if (inspectorRow != null && !state.revoked) SessionInspector(
        row = inspectorRow,
        point = inspector?.second ?: Offset.Zero,
        busy = inspectorRow.id in state.busyIds,
        message = snackbar.currentSnackbarData?.visuals?.message,
        error = state.actionErrors[inspectorRow.id],
        nowMs = nowMs,
        viewModel = viewModel,
        windowSize = IntSize(constraints.maxWidth, constraints.maxHeight),
        onOpen = { inspector = null; viewModel.action(inspectorRow.id, "open") },
        onDismiss = { inspector = null },
    )
}

// Card motion: one critically damped spring (about 350 ms) for placement and fade in; a leaving card goes at once.
private val CardPlacement = spring(dampingRatio = 1f, stiffness = 360f, visibilityThreshold = IntOffset.VisibilityThreshold)
private val CardFade = spring<Float>(dampingRatio = 1f, stiffness = 360f)

/**
 * When the keys change, keep the list at the same row slot (or at its first item with [top]), as the desktop keeps
 * its scroll offset. A lazy list alone follows its first visible key, so rows that move above it go off screen.
 * [lead] is the number of items before the first row, so a warning that comes or goes does not shift the rows.
 * The request runs after the composition and before the next measure, so that measure uses the index.
 */
@Composable
private fun KeepPositionOnChange(state: LazyListState, keys: List<Any>, top: Boolean = false, lead: Int = 0) {
    val last = remember(state) { arrayOfNulls<List<Any>>(1) }
    val lastLead = remember(state) { intArrayOf(lead) }
    SideEffect {
        val previous = last[0]
        if (previous === keys) return@SideEffect
        last[0] = keys
        val oldLead = lastLead[0]
        lastLead[0] = lead
        if (!keepIndexOnChange(previous, keys, state.isScrollInProgress)) return@SideEffect
        if (top) {
            state.requestScrollToItem(0)
        } else {
            val first = state.firstVisibleItemIndex
            val offset = state.firstVisibleItemScrollOffset
            val keptIndex = keys.indexOf(previous?.getOrNull(first))
            val (index, keptOffset) = keptPosition(first, offset, oldLead, lead, keptIndex)
            state.requestScrollToItem(index, keptOffset)
        }
    }
}

@Composable
private fun SessionChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    dot: Boolean = false,
    icon: ImageVector? = null,
) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        // Desktop pill: small and round, accent background when selected. The chip keeps its 48 dp touch area.
        // An icon pill shows only its icon; the label is its content description.
        modifier = modifier.heightIn(min = 28.dp).then(if (icon != null) Modifier.semantics { contentDescription = label } else Modifier),
        shape = CircleShape,
        border = FilterChipDefaults.filterChipBorder(true, selected, borderColor = hexColor(controlOutline(LocalPalette.current))),
        label = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (icon != null) Icon(icon, contentDescription = null, modifier = Modifier.size(14.dp))
                else Text(label, fontSize = 12.sp)
                if (dot) Box(Modifier.size(5.dp).background(
                    if (selected) MaterialTheme.colorScheme.onSecondaryContainer else MaterialTheme.colorScheme.primary, CircleShape))
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
private fun SessionCard(
    row: Thread, comfortable: Boolean, drawerView: Boolean, busy: Boolean, opening: Boolean, confirmed: Boolean,
    nowMs: Long, messageLit: Boolean, onProviderCenter: (Offset) -> Unit, onOpen: () -> Unit, onActions: (Offset) -> Unit,
    onCorner: (String) -> Unit, modifier: Modifier = Modifier,
) {
    val palette = LocalPalette.current
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    // The inspector opens at the long-press point; a long click with no touch (accessibility) uses the card center.
    val coordinates = remember { mutableStateOf<LayoutCoordinates?>(null) }
    val press = remember { mutableStateOf<Offset?>(null) }
    LaunchedEffect(interaction) {
        interaction.interactions.collect { press.value = (it as? PressInteraction.Press)?.pressPosition }
    }
    val tones = cardTones(palette, row, comfortable, drawerView, pressed, nowMs)
    val left = limitLeft(row, nowMs)
    val limited = left > 0
    val countdown = if (limited) limitText(left) else ""
    val indicator = attentionIndicator(row, drawerView, nowMs)
    val state = stateLabel(row.state)
    val working = if (row.state == "working") workingDuration(row.workingSinceMs, nowMs) else ""
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
        row.title, row.projectName, state,
        if (limited) "Usage limit. Resets in ${spokenLimit(left)}" else working.ifEmpty { idleAge(row.updatedAtMs, nowMs) },
        indicatorMeaning,
        if (row.pinned) "Pinned" else "",
        if (row.drawer) "In the drawer" else "",
        row.sourceLabel.ifEmpty { row.providerLabel },
        if (!row.canOpen) "No direct link" else "",
        if (opening) "Opening" else "",
    ).filter { it.isNotBlank() }.joinToString(". ")
    val title = if (opening) "Opening…" else row.title
    val fontScale = LocalDensity.current.fontScale
    val card = modifier.fillMaxWidth().onPlaced { coordinates.value = it }
        .heightIn(min = (if (comfortable) comfortableCardHeight(fontScale) else compactRowHeight(fontScale)).dp)
        .combinedClickable(
            interactionSource = interaction,
            indication = remember(palette.highlight) { HighlightIndication(hexColor(palette.highlight)) },
            enabled = !busy,
            role = Role.Button,
            onClickLabel = if (row.canOpen) "Open on PC" else "Show link information",
            onLongClickLabel = "Open session inspector",
            onLongClick = {
                val placed = coordinates.value?.takeIf { it.isAttached }
                if (placed != null) onActions(placed.localToWindow(
                    press.value ?: Offset(placed.size.width / 2f, placed.size.height / 2f)))
            },
            onClick = onOpen,
        )
    val mark: @Composable () -> Unit = {
        ProviderMark(row, limited, messageLit, palette, Modifier.onGloballyPositioned {
            onProviderCenter(it.positionInRoot() + Offset(it.size.width / 2f, it.size.height / 2f))
        })
    }
    if (!comfortable) Row(
        modifier = card.semantics(mergeDescendants = true) { contentDescription = description }.padding(horizontal = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.clearAndSetSemantics { }) { mark() }
        Text(title, fontSize = 13.sp, lineHeight = 16.sp, color = hexColor(tones.title), maxLines = 1,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).clearAndSetSemantics { })
        if (indicator.isNotEmpty()) IndicatorMark(indicator, palette)
        if (limited) LimitClock(tones.state)
        Text(if (limited) "Resets $countdown" else state + if (working.isNotEmpty()) " ·$working" else "",
            fontSize = 11.sp, lineHeight = 14.sp, color = hexColor(tones.state), maxLines = 1,
            modifier = Modifier.clearAndSetSemantics { })
    } else Box(card.semantics { contentDescription = description }) {
        Column(
            modifier = Modifier.fillMaxWidth().align(Alignment.CenterStart)
                .padding(start = 8.dp, end = 8.dp, top = COMFORTABLE_PADDING.dp, bottom = COMFORTABLE_PADDING.dp),
            verticalArrangement = Arrangement.spacedBy(COMFORTABLE_SPACING.dp),
        ) {
            Row(Modifier.padding(end = 54.dp).clearAndSetSemantics { }, horizontalArrangement = Arrangement.spacedBy(7.dp),
                verticalAlignment = Alignment.CenterVertically) {
                mark()
                Text(row.projectName.ifEmpty { "No project" }, fontSize = 11.sp, lineHeight = CAPTION_LINE_HEIGHT.sp,
                    color = hexColor(tones.caption), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(title, fontSize = 13.sp, lineHeight = TITLE_LINE_HEIGHT.sp, color = hexColor(tones.title),
                maxLines = COMFORTABLE_TITLE_LINES, minLines = COMFORTABLE_TITLE_LINES, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 21.dp, end = 54.dp).clearAndSetSemantics { })
            Row(Modifier.padding(start = 21.dp).clearAndSetSemantics { }, horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically) {
                if (limited) LimitClock(tones.state)
                Text(if (limited) "Resets in" else state, fontSize = 11.sp, lineHeight = CAPTION_LINE_HEIGHT.sp,
                    color = hexColor(tones.state), maxLines = 1)
                Text(countdown.ifEmpty { working.ifEmpty { idleAge(row.updatedAtMs, nowMs) } }, fontSize = 11.sp,
                    lineHeight = CAPTION_LINE_HEIGHT.sp, color = hexColor(tones.caption), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.End, modifier = Modifier.weight(1f))
            }
        }
        Row(Modifier.align(Alignment.TopEnd).padding(end = 5.dp, top = 2.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            val controls = cornerControls(row, drawerView, confirmed, nowMs)
            val title = row.title.ifEmpty { "Untitled session" }
            controls.firstOrNull { it.kind == "drawer" }?.let { CornerButton(it, title, busy, palette, onCorner) }
            // The read and pin slots keep their places, as on the desktop.
            Box(Modifier.size(24.dp)) {
                controls.firstOrNull { it.kind !in setOf("drawer", "pin") }?.let { CornerButton(it, title, busy, palette, onCorner) }
            }
            Box(Modifier.size(24.dp)) {
                controls.firstOrNull { it.kind == "pin" }?.let { CornerButton(it, title, busy, palette, onCorner) }
            }
        }
    }
}

@Composable
private fun ProviderMark(
    row: Thread, limited: Boolean, messageLit: Boolean, palette: Palette, modifier: Modifier, dot: Boolean = true,
) {
    val text = hexColor(palette.text)
    val marker = remember(row.sourceColor, row.sourceCount, row.sourceShowMarker, palette) {
        if (!row.sourceShowMarker || row.sourceCount <= 1 || !row.sourceColor.matches(Regex("#[0-9a-fA-F]{6}"))) ""
        else displaySourceColor(row.sourceColor.lowercase(), listOf(palette.background, palette.highlight))
    }
    Box(modifier.size(PROVIDER_MARK_SIZE.dp)) {
        Icon(
            painterResource(providerIcon(row.provider)),
            contentDescription = null,
            tint = if (messageLit) hexColor(palette.accent) else text.copy(alpha = if (limited) .4f else .65f),
            modifier = Modifier.fillMaxSize(),
        )
        // The Soft dot: a 6 dp fill with a 1 dp background rim at the lower left of the mark.
        if (dot && marker.isNotEmpty()) Box(
            Modifier.align(Alignment.BottomStart).size(8.dp).background(hexColor(palette.background), CircleShape)
                .padding(1.dp).background(hexColor(marker), CircleShape),
        )
    }
}

@Composable
private fun LimitClock(color: String) = Icon(painterResource(R.drawable.ic_schedule), contentDescription = null,
    tint = hexColor(color), modifier = Modifier.size(LIMIT_CLOCK_SIZE.dp))

@Composable
private fun IndicatorMark(indicator: String, palette: Palette) {
    when (indicator) {
        "question" -> Text("?", color = hexColor(palette.accent), fontSize = 11.sp, lineHeight = 14.sp,
            fontWeight = FontWeight.ExtraBold)
        "dot" -> Box(Modifier.size(7.dp).background(hexColor(palette.accent), CircleShape))
        "discard" -> Box(Modifier.size(9.dp).border(1.5.dp, hexColor(palette.text), CircleShape))
        "stop" -> Box(Modifier.size(7.dp).background(hexColor(palette.muted), RoundedCornerShape(1.dp)))
    }
}

@Composable
private fun CornerButton(control: CornerControl, title: String, busy: Boolean, palette: Palette, onCorner: (String) -> Unit) {
    val text = hexColor(palette.text)
    val background = when (control.kind) {
        "dot", "drawer" -> text.copy(alpha = .08f)
        "question" -> if (control.action != null) text.copy(alpha = .08f) else Color.Transparent
        "pin" -> text.copy(alpha = .12f)
        "confirmed" -> hexColor(palette.success).copy(alpha = .12f)
        else -> Color.Transparent
    }
    // The circle is 24 dp; the touch area is 48 dp around it (it reaches past the slot, as a touch inset).
    Box(
        Modifier.size(24.dp).wrapContentSize(unbounded = true).size(48.dp)
            .then(if (control.action == null) Modifier.semantics { contentDescription = "${control.label}: $title" }
            else Modifier.clickable(
                interactionSource = null,
                indication = null,
                enabled = !busy,
                role = Role.Button,
                onClickLabel = control.label,
            ) { onCorner(control.action) }.semantics {
                contentDescription = "${control.label}: $title"
                if (busy) stateDescription = "Busy"
            }),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(24.dp).background(background, CircleShape), contentAlignment = Alignment.Center) {
            when (control.kind) {
                "confirmed" -> Icon(Icons.Default.Check, contentDescription = null, tint = hexColor(palette.success),
                    modifier = Modifier.size(12.dp))
                "pin" -> Icon(PinIcon, contentDescription = null, tint = text, modifier = Modifier.size(12.dp))
                "drawer" -> DrawerGlyph(hexColor(palette.accent), hexColor(palette.background))
                else -> IndicatorMark(control.kind, palette)
            }
        }
    }
}

// The filled drawer glyph of set_palette: a 9x5 dp rounded box with a 3x1 dp handle in the background color.
@Composable
private fun DrawerGlyph(color: Color, handle: Color) = Canvas(Modifier.size(9.dp, 5.dp)) {
    drawRoundRect(color, cornerRadius = CornerRadius(2.dp.toPx()))
    drawRect(handle, topLeft = Offset((size.width - 3.dp.toPx()) / 2, (size.height - 1.dp.toPx()) / 2),
        size = Size(3.dp.toPx(), 1.dp.toPx()))
}

// The pressed highlight: the palette highlight behind the card, rounded 3 dp, fading in and out in 100 ms.
private class HighlightIndication(private val color: Color) : IndicationNodeFactory {
    override fun create(interactionSource: InteractionSource): DelegatableNode = HighlightNode(interactionSource, color)
    override fun equals(other: Any?) = other is HighlightIndication && other.color == color
    override fun hashCode() = color.hashCode()
}

private class HighlightNode(private val source: InteractionSource, private val color: Color) :
    Modifier.Node(), DrawModifierNode {
    private val alpha = Animatable(0f)

    override fun onAttach() {
        coroutineScope.launch {
            val presses = mutableSetOf<PressInteraction.Press>()
            source.interactions.collect { interaction ->
                when (interaction) {
                    is PressInteraction.Press -> presses += interaction
                    is PressInteraction.Release -> presses -= interaction.press
                    is PressInteraction.Cancel -> presses -= interaction.press
                }
                val target = if (presses.isEmpty()) 0f else 1f
                launch { alpha.animateTo(target, tween(100)) }
            }
        }
    }

    override fun ContentDrawScope.draw() {
        if (alpha.value > 0f) drawRoundRect(color.copy(alpha = color.alpha * alpha.value),
            cornerRadius = CornerRadius(3.dp.toPx()))
        drawContent()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FilterSheet(filter: Filter, onChange: (Filter) -> Unit, onDismiss: () -> Unit) {
    val density = LocalDensity.current
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        CompositionLocalProvider(LocalDensity provides density) {
            Column(
                modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp)
                    .padding(bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("Filters", style = MaterialTheme.typography.headlineSmall)
                Spacer(Modifier.height(8.dp))
                Text("App", style = MaterialTheme.typography.titleMedium)
                APP_FILTERS.forEach { (app, label) ->
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

// The inspector shadow needs room inside the popup window; the panel keeps 16 dp from the safe area edges.
private val INSPECTOR_SHADOW_ROOM = 8.dp
private val INSPECTOR_MARGIN = 16.dp

/**
 * The session inspector (desktop row panel, option E): a focusable popup at the long-press point. Back and an
 * outside tap close it. Every change uses the existing actions; the panel stays open and shows the current row.
 */
@Composable
private fun SessionInspector(
    row: Thread, point: Offset, busy: Boolean, message: String?, error: String?, nowMs: Long, viewModel: SessionsViewModel,
    windowSize: IntSize, onOpen: () -> Unit, onDismiss: () -> Unit,
) {
    val density = LocalDensity.current
    val direction = LocalLayoutDirection.current
    val insets = WindowInsets.safeDrawing
    val margin = with(density) { (INSPECTOR_MARGIN - INSPECTOR_SHADOW_ROOM).roundToPx() }
    val room = with(density) { INSPECTOR_SHADOW_ROOM.roundToPx() }
    val safe = IntRect(
        insets.getLeft(density, direction) + margin, insets.getTop(density) + margin,
        windowSize.width - insets.getRight(density, direction) - margin, windowSize.height - insets.getBottom(density) - margin,
    )
    val width = with(density) { minOf(300.dp, windowSize.width.toDp() - INSPECTOR_MARGIN * 2) }
    val maxHeight = with(density) { maxOf(0, safe.height - 2 * room).toDp() }
    // A change keeps its chosen state while its action and the board refresh after it are pending.
    val chosen = remember(row.id) { mutableStateMapOf<String, Boolean>() }
    // Desktop restore_panel_focus: a control is disabled while its action runs, so it gets the focus back after.
    val focusers = remember(row.id) { mutableMapOf<String, FocusRequester>() }
    var focused by remember(row.id) { mutableStateOf<String?>(null) }
    var refocus by remember(row.id) { mutableStateOf<String?>(null) }
    fun focusable(key: String) = Modifier.focusRequester(focusers.getOrPut(key) { FocusRequester() })
        .onFocusChanged { if (it.isFocused) focused = key else if (focused == key) focused = null }
    fun started(key: String): Boolean {
        val pending = row.id in viewModel.state.value.busyIds
        if (pending && focused == key) refocus = key
        return pending
    }
    val controls = rowPanelControls(row)
    LaunchedEffect(row, busy, refocus) {
        if (!busy) {
            chosen.clear()
            val key = panelFocusReturn(refocus, controls)
            refocus = null
            if (key != null) focusers[key]?.requestFocus()
        }
    }
    fun change(key: String, value: Boolean, action: String?) {
        if (action == null) return
        viewModel.action(row.id, action)
        // An action that sends nothing leaves the row idle, so the control returns to the row state.
        if (started(key)) chosen[key] = value
    }
    val palette = LocalPalette.current
    val surface = mixColor(palette.background, palette.text, .06)
    val group = mixColor(surface, palette.text, .06)
    val button = mixColor(surface, palette.text, .1)
    val move = mixColor(group, palette.text, .1)
    val ring = edgeColor(surface, palette.accent, .7, listOf(palette.background, surface))
    val text = hexColor(palette.text)
    val muted = hexColor(readableColor(palette.muted, palette.text, listOf(surface, group)))
    val stateColor = when {
        row.state == "working" -> hexColor(readableColor(palette.success, palette.text, listOf(surface)))
        row.state == "waiting" -> hexColor(readableColor(palette.warning, palette.text, listOf(surface)))
        controls.getValue("unread").on -> text
        else -> muted
    }
    val time = (if (row.state == "working") workingDuration(row.workingSinceMs, nowMs) else "")
        .ifEmpty { idleAge(row.updatedAtMs, nowMs) }
    val title = row.title.trim().replace(Regex("\\s+"), " ").ifEmpty { "Untitled session" }
    val app = row.providerLabel +
        if (row.sourceLabel.isNotEmpty() && row.sourceLabel != row.providerLabel) " · ${row.sourceLabel}" else ""
    val shape = RoundedCornerShape(12.dp)
    Popup(
        popupPositionProvider = remember(point, safe) { InspectorPosition(point, safe) },
        onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = true),
        content = withDensity(density) {
            Column(
                Modifier.padding(INSPECTOR_SHADOW_ROOM).width(width).heightIn(max = maxHeight)
                    .shadow(12.dp, shape, ambientColor = Color.Black, spotColor = Color.Black)
                    .background(hexColor(surface), shape).border(1.dp, hexColor(ring), shape)
                    .semantics { paneTitle = title },
            ) {
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(12.dp)) {
                    Column(
                        Modifier.padding(start = 2.dp, end = 2.dp, bottom = 12.dp).semantics(mergeDescendants = true) { },
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
                            ProviderMark(row, limited = false, messageLit = false, palette = palette, modifier = Modifier, dot = false)
                            // The API sends no PC home folder, so the path has no ~ prefix.
                            Text(row.cwd.ifEmpty { row.projectName }.ifEmpty { "No project" }, fontSize = 11.sp,
                                lineHeight = CAPTION_LINE_HEIGHT.sp, color = muted, maxLines = 1, overflow = TextOverflow.StartEllipsis)
                        }
                        Text(title, fontSize = 13.sp, lineHeight = 17.sp, fontWeight = FontWeight.Bold, color = text,
                            maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(stateLabel(row.state) + if (time.isNotEmpty()) " · $time" else "", fontSize = 11.sp,
                            lineHeight = CAPTION_LINE_HEIGHT.sp, color = stateColor)
                    }
                    val canOpen = row.canOpen && !busy
                    Box(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp).alpha(if (canOpen) 1f else .5f)
                            .clip(RoundedCornerShape(8.dp)).background(hexColor(button))
                            .clickable(enabled = canOpen, role = Role.Button, onClick = onOpen),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("Open in $app", fontSize = 13.sp,
                            fontWeight = FontWeight.Bold, color = text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(horizontal = 12.dp))
                    }
                    Spacer(Modifier.height(12.dp))
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(hexColor(group))) {
                        val rule = hexColor(palette.divider)
                        var first = true
                        @Composable
                        fun item(content: @Composable () -> Unit) {
                            if (!first) HorizontalDivider(thickness = 1.dp, color = rule)
                            first = false
                            content()
                        }
                        @Composable
                        fun switch(key: String, label: String, note: String = "") {
                            val control = controls[key] ?: return
                            item {
                                PanelSwitch(label, note, chosen[key] ?: control.on, control.action != null && !busy, text, muted,
                                    palette, focusable(key)) { change(key, it, control.action) }
                            }
                        }
                        switch("unread", "Unread", rowPanelNote(row))
                        switch("drawer", "In the drawer")
                        switch("pinned", "Pinned")
                        if ("order" in controls) item {
                            Row(
                                Modifier.fillMaxWidth().heightIn(min = 48.dp).alpha(if (busy) .5f else 1f)
                                    .padding(start = 12.dp, end = 6.dp),
                                horizontalArrangement = Arrangement.spacedBy(1.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text("Pin order", fontSize = 13.sp, color = text, modifier = Modifier.weight(1f).padding(end = 9.dp))
                                PanelButton("Earlier", "Move pin earlier", RoundedCornerShape(6.dp, 0.dp, 0.dp, 6.dp),
                                    hexColor(move), text, !busy, focusable("earlier")) { viewModel.action(row.id, "pin-up"); started("earlier") }
                                PanelButton("Later", "Move pin later", RoundedCornerShape(0.dp, 6.dp, 6.dp, 0.dp),
                                    hexColor(move), text, !busy, focusable("later")) { viewModel.action(row.id, "pin-down"); started("later") }
                            }
                        }
                        switch("discard", "Discard result", "Go to read Idle when this task ends")
                    }
                }
                // Desktop asb-panel-error: the last failed action of this row, in the Adwaita error color made readable.
                // It is outside the scroll area, so it stays in view when the panel content is taller than the panel.
                if (error != null) Text(error, fontSize = 11.sp, lineHeight = CAPTION_LINE_HEIGHT.sp,
                    color = hexColor(readableColor(if (luminance(palette.background) < .5) "#ff7b63" else "#c01c28",
                        palette.text, listOf(surface))),
                    modifier = Modifier.padding(start = 14.dp, end = 14.dp, bottom = 12.dp)
                        .semantics { liveRegion = LiveRegionMode.Polite })
                // The panel covers the snackbar, so it shows the current message too.
                if (message != null && message != error) Text(message, fontSize = 11.sp, lineHeight = CAPTION_LINE_HEIGHT.sp, color = muted,
                    modifier = Modifier.padding(start = 14.dp, end = 14.dp, bottom = 12.dp))
            }
        },
    )
}

@Composable
private fun PanelSwitch(
    label: String, note: String, checked: Boolean, enabled: Boolean, text: Color, muted: Color, palette: Palette,
    modifier: Modifier, onChange: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).alpha(if (enabled) 1f else .5f).then(modifier)
            .toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onChange)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, fontSize = 13.sp, lineHeight = TITLE_LINE_HEIGHT.sp, color = text)
            if (note.isNotEmpty()) Text(note, fontSize = 11.sp, lineHeight = CAPTION_LINE_HEIGHT.sp, color = muted)
        }
        // The row is the toggle; the switch only shows the state, so it keeps its colors when the row is disabled.
        Switch(
            checked = checked,
            onCheckedChange = null,
            colors = SwitchDefaults.colors(
                checkedThumbColor = hexColor(palette.background),
                checkedTrackColor = hexColor(palette.accent),
                checkedBorderColor = hexColor(palette.accent),
                uncheckedThumbColor = Color.White,
                uncheckedTrackColor = text.copy(alpha = .2f),
                uncheckedBorderColor = Color.Transparent,
            ),
        )
    }
}

@Composable
private fun PanelButton(
    label: String, description: String, shape: RoundedCornerShape, background: Color, text: Color, enabled: Boolean,
    modifier: Modifier, onClick: () -> Unit,
) {
    Box(
        Modifier.heightIn(min = 48.dp).then(modifier).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        Text(label, fontSize = 12.sp, color = text,
            modifier = Modifier.background(background, shape).padding(horizontal = 10.dp, vertical = 6.dp))
    }
}

// Port of panel_place: centered on the point, below it when there is room or more room than above, inside safe.
private class InspectorPosition(private val point: Offset, private val safe: IntRect) : PopupPositionProvider {
    override fun calculatePosition(
        anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize,
    ): IntOffset {
        val right = minOf(safe.right, windowSize.width)
        val bottom = minOf(safe.bottom, windowSize.height)
        val x = point.x.roundToInt()
        val y = point.y.roundToInt()
        val (width, height) = popupContentSize
        val left = (x - width / 2).coerceAtMost(right - width).coerceAtLeast(safe.left)
        val top = (if (bottom - y >= height || bottom - y >= y - safe.top) y else y - height)
            .coerceAtMost(bottom - height).coerceAtLeast(safe.top)
        return IntOffset(left, top)
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

private fun flowEndpoint(
    id: String,
    centers: Map<String, Offset>,
    origin: Offset,
    viewport: IntSize,
    layout: LazyListLayoutInfo,
    indexes: Map<String, Int>,
    capacity: Int,
    rowHeight: Float,
    gap: Float,
    density: Float,
): MessageEndpoint? {
    if (viewport.width <= 4 * density) return null
    val index = indexes[id] ?: return null
    val column = index / capacity
    val visible = layout.visibleItemsInfo.map { it.index }
    val left = 2 * density
    val right = viewport.width - 2 * density
    if (column in visible) {
        val center = centers[id]?.minus(origin) ?: return null
        val x = center.x.coerceIn(left, right)
        return MessageEndpoint(Offset(x, center.y), x != center.x)
    }
    val first = visible.minOrNull() ?: return null
    // An off-screen card has no measured place; use its row slot in the column.
    val y = (index % capacity) * (rowHeight + gap) + rowHeight / 2
    return MessageEndpoint(Offset(if (column < first) left else right, y.coerceAtMost(viewport.height.toFloat())), true)
}

private fun DrawScope.drawMessage(
    flight: MessageFlight, nowNanos: Long, start: MessageEndpoint, end: MessageEndpoint, color: Color,
    sideEdges: Boolean,
) {
    val elapsed = flight.elapsedMs(nowNanos)
    fun edge(point: Offset, ms: Double) {
        val alpha = minOf(1.0, ms / 120, 1 - (ms - 420) / 300).coerceAtLeast(0.0).toFloat()
        // Column Flow has its edge marks at the left and right edges, so they stand upright there.
        val mark = if (sideEdges) Size(3.dp.toPx(), 18.dp.toPx()) else Size(18.dp.toPx(), 3.dp.toPx())
        if (alpha > 0) drawRoundRect(
            color.copy(alpha = alpha), topLeft = point - Offset(mark.width / 2, mark.height / 2),
            size = mark, cornerRadius = CornerRadius(1.5.dp.toPx()),
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

// The filter-lines icon of the desktop Filters pill: three centered lines, 1.8 wide with round caps.
private val FiltersIcon = ImageVector.Builder("Filters", 24.dp, 24.dp, 24f, 24f).apply {
    path(stroke = SolidColor(Color.Black), strokeLineWidth = 1.8f, strokeLineCap = StrokeCap.Round) {
        moveTo(4f, 7f)
        horizontalLineTo(20f)
        moveTo(7f, 12f)
        horizontalLineTo(17f)
        moveTo(10f, 17f)
        horizontalLineTo(14f)
    }
}.build()
