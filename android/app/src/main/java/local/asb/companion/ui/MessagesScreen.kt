package local.asb.companion.ui

import android.animation.ValueAnimator
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt
import kotlinx.coroutines.delay
import local.asb.companion.R
import local.asb.companion.data.ActivityMachine
import local.asb.companion.data.BucketCount
import local.asb.companion.data.messageBucketPartial
import local.asb.companion.data.messageBuckets
import local.asb.companion.data.offlineBandColor
import local.asb.companion.data.offlineRingColor
import local.asb.companion.data.bucketPairCounts
import local.asb.companion.data.BusyPair
import local.asb.companion.data.UNLISTED
import local.asb.companion.data.busiestPairs
import local.asb.companion.data.messageStatusLabel
import local.asb.companion.data.seatTitles
import local.asb.companion.data.ActivityMessage
import local.asb.companion.data.ActivityMessages
import local.asb.companion.data.Chord
import local.asb.companion.data.MESSAGE_PERIODS
import local.asb.companion.data.STATUS_TIPS
import local.asb.companion.data.Seat
import local.asb.companion.data.Ledger
import local.asb.companion.data.SeatCount
import local.asb.companion.data.activeSeats
import local.asb.companion.data.activityTimes
import local.asb.companion.data.appKey
import local.asb.companion.data.appLabel
import local.asb.companion.data.arrivals
import local.asb.companion.data.chordGray
import local.asb.companion.data.chords
import local.asb.companion.data.mixColor
import local.asb.companion.data.ledger
import local.asb.companion.data.newestMessage
import local.asb.companion.data.periodLabel
import local.asb.companion.data.seatCounts
import local.asb.companion.data.seatedSeats
import local.asb.companion.data.statusKey
import local.asb.companion.data.statusLabel
import local.asb.companion.net.AsbApi
import local.asb.companion.net.AsbError

// ---------- Shared by Messages and Usage ----------

/** The surfaces of the Messages and Usage screens, from the Board palette. */
internal class ActivityColors(val background: Color, val track: Color, val edge: Color, val rule: Color, val text: Color,
    val muted: Color, val accent: Color, val divider: Color, val status: Map<String, Color>, val statusText: Map<String, Color>,
    val statusWords: Map<String, Color>, val apps: Map<String, Color>, val hues: List<Color>, val tokens: Map<String, Color>,
    /** The label of a selected choice on the [track] fill: the accent with 4.5:1 on it (D17 A). */
    val choice: Color) {
    /** The hue of the machine at [index] in machine order; the list repeats. */
    fun hue(index: Int): Color = hues[index.coerceAtLeast(0) % hues.size]
}

@Composable
internal fun activityColors(): ActivityColors {
    val palette = LocalPalette.current
    return remember(palette) { activityColorsOf(palette) }
}

/** The status swatch colors; Unknown has 3:1 on the background. */
internal fun statusColor(status: String, colors: ActivityColors): Color = colors.status.getValue(statusKey(status))

/** The status text colors: accepted muted, written #959ba3, the others their swatch. */
internal fun statusTextColor(status: String, colors: ActivityColors): Color = colors.statusText.getValue(statusKey(status))

/** The status word color of text on the background: [statusTextColor] with 4.5:1. Icons and swatches keep their colors. */
internal fun statusWordColor(status: String, colors: ActivityColors): Color = colors.statusWords.getValue(statusKey(status))

/** The app colors; Other has 3:1 on the background. */
internal fun appColor(app: String, colors: ActivityColors): Color = colors.apps.getValue(app)

internal fun machineOffline(machine: ActivityMachine?): Boolean = machine == null || machine.state !in setOf("local", "online")

/** The animator duration scale is 0 when the user turned animations off. */
internal fun animatorsEnabled(): Boolean = ValueAnimator.areAnimatorsEnabled()

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ActivityTopBar(title: String, onBack: () -> Unit, subtitle: String = "") {
    TopAppBar(windowInsets = SafeTopBarInsets, title = {
        Column {
            Text(title)
            if (subtitle.isNotEmpty()) {
                Text(subtitle, style = MaterialTheme.typography.bodySmall, color = activityColors().muted, maxLines = 1,
                    overflow = TextOverflow.Ellipsis)
            }
        }
    }, navigationIcon = {
        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
    })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChoiceRow(choices: List<Pair<String, String>>, selected: String, modifier: Modifier = Modifier,
    descriptions: Map<String, String> = emptyMap(), enabled: Boolean = true, onSelect: (String) -> Unit) {
    val colors = activityColors()
    // D17 A: a selected choice has the neutral track fill and its label in the accent at weight 700; a selected disabled choice
    // keeps the track fill with muted text.
    val buttons = SegmentedButtonDefaults.colors(activeContainerColor = colors.track, activeContentColor = colors.choice,
        disabledActiveContainerColor = colors.track, disabledActiveContentColor = colors.muted, disabledInactiveContentColor = colors.muted)
    SingleChoiceSegmentedButtonRow(modifier.fillMaxWidth()) {
        choices.forEachIndexed { index, (value, label) ->
            SegmentedButton(
                selected = selected == value,
                onClick = { onSelect(value) },
                enabled = enabled,
                colors = buttons,
                shape = SegmentedButtonDefaults.itemShape(index, choices.size),
                modifier = Modifier.heightIn(min = 48.dp)
                    .then(descriptions[value]?.let { Modifier.semantics { contentDescription = it } } ?: Modifier),
                icon = {},
            ) { Text(label, maxLines = 1, fontWeight = if (selected == value) FontWeight.Bold else null) }
        }
    }
}

/** A 7 dp machine dot: filled for a local or online machine, a 1.5 dp ring for an offline one. */
@Composable
internal fun MachineDot(hue: Color, offline: Boolean) {
    Box(Modifier.size(7.dp).then(
        if (offline) Modifier.border(1.5.dp, hue, CircleShape) else Modifier.background(hue, CircleShape)))
}

/** A machine chip: the dot, the name, and Offline for an offline machine; 22 dp high with a 1 dp divider border. */
@Composable
internal fun MachineChip(machine: ActivityMachine, hue: Color, colors: ActivityColors, modifier: Modifier = Modifier,
    strike: Boolean = false) {
    Row(
        modifier.height(22.dp).border(1.dp, colors.divider, RoundedCornerShape(4.dp)).padding(horizontal = 8.dp)
            .clearAndSetSemantics { contentDescription = "${machine.name}, ${machineStateText(machine)}" },
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MachineDot(hue, machineOffline(machine))
        Text(machine.name, fontSize = 12.sp, color = colors.text, maxLines = 1,
            style = TextStyle(textDecoration = if (strike) TextDecoration.LineThrough else null))
        if (machineOffline(machine)) Text(machineStateText(machine), fontSize = 12.sp, color = colors.muted, maxLines = 1)
    }
}

// The status marks of the preview (16 × 16, stroke 1.5).
private val STATUS_PATHS = mapOf(
    "accepted" to "M13.8 8a5.8 5.8 0 1 1-11.6 0a5.8 5.8 0 1 1 11.6 0M5.2 8.2l1.9 1.9 3.7-4",
    "written" to "M2.5 8h7M7 5l3 3-3 3M12.8 3.5v9",
    "held" to "M4.5 2.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM6.4 5.8v4.4M9.6 5.8v4.4",
    "not-sent" to "M13.8 8a5.8 5.8 0 1 1-11.6 0a5.8 5.8 0 1 1 11.6 0M3.9 12.1l8.2-8.2",
    "unknown" to "M13.8 8a5.8 5.8 0 1 1-11.6 0a5.8 5.8 0 1 1 11.6 0M6.3 6.4a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.3M8 11.4h.01",
).mapValues { PathParser().parsePathString(it.value).toPath() }

@Composable
internal fun StatusIcon(status: String, color: Color, size: Dp, label: Boolean = false) {
    val path = STATUS_PATHS.getValue(statusKey(status))
    val name = statusLabel(status)
    Canvas(Modifier.size(size).then(if (label) Modifier.semantics { contentDescription = name } else Modifier)) {
        scale(this.size.width / 16f, pivot = Offset.Zero) {
            drawPath(path, color, style = Stroke(1.5f, cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
    }
}

@Composable
internal fun ActivityLoading() {
    Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
}

@Composable
internal fun ActivityError(message: String, colors: ActivityColors, onRetry: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally) {
        Text(message, color = colors.text, textAlign = TextAlign.Center,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        Button(onClick = onRetry) { Text("Try again") }
    }
}

@Composable
internal fun ActivityEmpty(text: String, colors: ActivityColors) {
    Text(text, color = colors.muted, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(48.dp))
}

@Composable
internal fun SectionTitle(text: String, colors: ActivityColors) {
    Text(text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = colors.text, modifier = Modifier.padding(bottom = 6.dp))
}

/** Figures: the UI font with tabular numerals. */
internal val figures: TextStyle @Composable get() = LocalTextStyle.current.merge(TextStyle(fontFeatureSettings = "tnum"))

internal fun plural(count: Int, word: String) = "${formatCount(count.toLong())} $word" + if (count == 1) "" else "s"

/** Runs [fetch] now and then every [intervalMs] while the screen is resumed. */
@Composable
internal fun PollWhileResumed(vararg keys: Any?, intervalMs: () -> Long, fetch: suspend () -> Unit) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val currentFetch by rememberUpdatedState(fetch)
    val currentInterval by rememberUpdatedState(intervalMs)
    LaunchedEffect(lifecycle, *keys) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                currentFetch()
                delay(currentInterval())
            }
        }
    }
}

// ---------- Messages ----------

private const val FLIGHT_MS = 900L
private const val FADE_MS = 300L
private const val FLIGHT_GAP_MS = 150L
private val FlightEasing = CubicBezierEasing(.45f, 0f, .2f, 1f)
private val LIGHT = Color(0xff79b2ff)
private val GLOW = Color(0xff3987e5)

private class Flight(val message: ActivityMessage, val startNanos: Long) {
    val notSent get() = statusKey(message.status) == "not-sent"
    val endNanos get() = startNanos + (FLIGHT_MS + if (notSent) FADE_MS else 0) * 1_000_000
}

@Composable
fun MessagesScreen(api: AsbApi, engine: String, selected: String?, onSelect: (String?) -> Unit, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val colors = activityColors()
    var period by rememberSaveable { mutableStateOf("24h") }
    var reply by remember(engine, period) { mutableStateOf<ActivityMessages?>(null) }
    var error by remember(engine, period) { mutableStateOf<String?>(null) }
    var previous by remember(engine, period) { mutableStateOf<Set<String>?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    var flights by remember { mutableStateOf(emptyList<Flight>()) }
    var chordKey by remember { mutableStateOf<String?>(null) }
    var frameNanos by remember { mutableLongStateOf(0L) }
    var bucket by remember(reply?.buckets) { mutableStateOf<Int?>(null) }
    val strip = remember { StripPlace() }
    PollWhileResumed(api, engine, period, attempt, intervalMs = { 10_000L }) {
        try {
            val next = api.activityMessages(period, engine)
            val landed = arrivals(previous, next.messages, next.nowMs)
            previous = next.messages.map { it.id }.toSet()
            reply = next
            error = null
            if (landed.isNotEmpty() && animatorsEnabled()) {
                val base = System.nanoTime()
                flights = flights + landed.mapIndexed { index, message -> Flight(message, base + index * FLIGHT_GAP_MS * 1_000_000) }
            }
        } catch (cause: AsbError) {
            error = cause.message
        }
    }
    LaunchedEffect(flights.isNotEmpty()) {
        while (flights.isNotEmpty()) {
            withFrameNanos { frameNanos = it }
            flights = flights.filter { it.endNanos > frameNanos }
        }
    }
    Scaffold(contentWindowInsets = SafeContentInsets, topBar = { ActivityTopBar("Messages", onBack) }) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding), contentAlignment = Alignment.TopCenter) {
            Column(Modifier.widthIn(max = 840.dp).fillMaxWidth().onGloballyPositioned { strip.page = it }
                .pointerInput(Unit) { clearOnTapOutside(strip) { bucket = null } }.verticalScroll(rememberScrollState())) {
                val current = reply
                Column(Modifier.fillMaxWidth().background(colors.background).padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    ChoiceRow(MESSAGE_PERIODS.map { it to periodLabel(it) }, period) { period = it; chordKey = null }
                    if (current != null) {
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            current.machines.forEachIndexed { index, machine ->
                                MachineChip(machine, colors.hue(index), colors)
                            }
                        }
                        val seated = remember(current, selected) { seatedSeats(current, selected) }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("${seated.size} of ${activeSeats(current).size} sessions", fontSize = 12.sp, color = colors.muted,
                                modifier = Modifier.weight(1f))
                            LiveMark(colors)
                        }
                    }
                }
                HorizontalDivider(thickness = 1.dp, color = colors.divider)
                when {
                    current == null && error != null -> ActivityError(error.orEmpty(), colors) { attempt++ }
                    current == null -> ActivityLoading()
                    current.messages.isEmpty() && current.machines.isEmpty() -> ActivityEmpty("No messages in the last ${periodLabel(period)}", colors)
                    else -> {
                        error?.let { Text(it, fontSize = 12.sp, color = colors.muted, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) }
                        MessagesContent(current, selected, chordKey, flights, frameNanos, colors, bucket, strip, { bucket = it },
                            // A second tap on the selected seat or chord clears the selection.
                            onSeat = { onSelect(it.takeIf { id -> id != selected }); chordKey = null },
                            onChord = { chordKey = it.takeIf { key -> key != chordKey }; onSelect(null) },
                            onClear = { chordKey = null; onSelect(null) },
                            onPeriod = { period = it; chordKey = null })
                    }
                }
            }
        }
    }
}

/** Where the count strip is in the window, and the coordinates of the page that holds it. */
private class StripPlace {
    var page: LayoutCoordinates? = null
    var bounds = Rect.Zero
}

/** Runs [clear] after a tap (a touch that moves less than the touch slop) outside the count strip; it consumes nothing. */
private suspend fun androidx.compose.ui.input.pointer.PointerInputScope.clearOnTapOutside(strip: StripPlace, clear: () -> Unit) {
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        var moved = false
        while (true) {
            val change = awaitPointerEvent(PointerEventPass.Initial).changes.firstOrNull { it.id == down.id } ?: break
            if ((change.position - down.position).getDistance() > viewConfiguration.touchSlop) moved = true
            if (!change.pressed) break
        }
        val at = strip.page?.takeIf { it.isAttached }?.localToWindow(down.position) ?: return@awaitEachGesture
        if (!moved && !strip.bounds.contains(at)) clear()
    }
}

@Composable
private fun LiveMark(colors: ActivityColors) {
    val animate = remember { animatorsEnabled() }
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) {
            if (animate) {
                val transition = rememberInfiniteTransition(label = "live")
                val k by transition.animateFloat(0f, 1f, infiniteRepeatable(tween(2000, easing = LinearOutSlowInEasing),
                    RepeatMode.Restart), label = "pulse")
                Canvas(Modifier.size(7.dp)) {
                    drawCircle(LIGHT.copy(alpha = .6f * (1 - k)), radius = size.minDimension / 2 * (1 + 1.2f * k))
                }
            }
            Box(Modifier.size(7.dp).background(LIGHT, CircleShape))
        }
        Text("Live", fontSize = 12.sp, color = colors.muted)
    }
}

/** A quadratic chord with a length table, so a light moves at the speed the preview's getPointAtLength gives. */
private class Curve(val p0: Offset, val q: Offset, val p2: Offset) {
    /** The 49 points of the length table, for the chord ink under a label plate. */
    val points = List(49) { at(it / 48f) }
    private val lengths = FloatArray(49).also { for (i in 1..48) it[i] = it[i - 1] + (points[i] - points[i - 1]).getDistance() }

    fun at(t: Float): Offset {
        val u = 1 - t
        return p0 * (u * u) + q * (2 * u * t) + p2 * (t * t)
    }

    fun pointAtLength(fraction: Float): Offset {
        val target = fraction.coerceIn(0f, 1f) * lengths.last()
        val i = lengths.indexOfFirst { it >= target }.coerceAtLeast(1)
        val span = lengths[i] - lengths[i - 1]
        val k = if (span > 0) (target - lengths[i - 1]) / span else 0f
        return points[i - 1] + (points[i] - points[i - 1]) * k
    }

    fun distanceTo(point: Offset): Float = (1..48).minOf { segmentDistance(point, points[it - 1], points[it]) }

    val length: Float get() = lengths.last()

    val path: Path get() = Path().apply { moveTo(p0.x, p0.y); quadraticTo(q.x, q.y, p2.x, p2.y) }
}

/**
 * A chord to draw (the PC layout_table chords): [width] is its rest width; its stroke runs from [trim].first to [trim].second of
 * the length, less the gap at a not-sent end for the drawn width ([strokeTrim]); each not-sent receiver end of a mixed pair is a
 * polyline of points 4 dp apart, from the pin rim, [endWidth] (3 dp) wide.
 */
private class ChordDraw(val curve: Curve, val width: Float, val ends: List<List<Offset>>, val trim: Pair<Float, Float>, val endWidth: Float) {
    /** The part of the length that a stroke [width] wide draws. */
    fun drawn(width: Float, dp: Float): Pair<Float, Float> = if (ends.isEmpty()) trim else strokeTrim(trim, curve.length, width, dp)

    /** The trimmed stroke: the whole curve, or a polyline when an end cuts it. */
    fun stroke(width: Float, dp: Float): Path = if (ends.isEmpty()) curve.path else {
        val (low, high) = drawn(width, dp)
        val steps = max(2, kotlin.math.ceil((high - low) * curve.length / (4 * dp)).toInt())
        polyline((0..steps).map { curve.pointAtLength(low + (high - low) * it / steps) })
    }
}

private fun chordDraw(chord: Chord, curve: Curve, nMax: Int, dp: Float): ChordDraw {
    val width = if (chord.bad) 2 * dp else (1.5f + 7 * sqrt(chord.n.toFloat() / nMax)) * dp
    val length = curve.length
    val ends = mutableListOf<List<Offset>>()
    var trim = 0f to 1f
    if (chord.mixed && length > 0) {
        for ((count, forward) in listOf(chord.badAb to true, chord.badBa to false)) {
            if (count == 0) continue
            val (near, far) = notSentEndSpan(length, dp, forward)
            val steps = max(1, kotlin.math.ceil(abs(far - near) / (4 * dp)).toInt())
            ends += (0..steps).map { i -> curve.pointAtLength((near + (far - near) * i / steps) / length) }
            // The stroke ends where the dashed end starts.
            trim = if (forward) trim.first to min(trim.second, far / length) else max(trim.first, far / length) to trim.second
        }
    }
    return ChordDraw(curve, width, ends, trim, 3 * dp)
}

private fun polyline(points: List<Offset>): Path = Path().apply {
    moveTo(points[0].x, points[0].y)
    for (p in points.drop(1)) lineTo(p.x, p.y)
}

private fun segmentDistance(p: Offset, a: Offset, b: Offset): Float {
    val ab = b - a
    val length = ab.x * ab.x + ab.y * ab.y
    val t = if (length > 0) (((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / length).coerceIn(0f, 1f) else 0f
    return (p - (a + ab * t)).getDistance()
}

/** The round table geometry of boards.html tableGeom, in pixels for a square of [side]; [shrink] makes the ring smaller. */
private class TableGeom(val side: Float, val dp: Float, seated: List<Seat>, machines: List<ActivityMachine>, val shrink: Float = 0f) {
    val c = Offset(side / 2, side / 2)
    val ro = max(24 * dp, side / 2 - 56 * dp - shrink)
    // With no seats the band is 8 dp, and the disc takes the free radius inside it less 24 dp (the PC table_geometry).
    val ri = ro - (if (seated.isEmpty()) 8 else 10) * dp
    val rp = ri - 36 * dp
    val rc = if (seated.isEmpty()) max(0f, ri - 24 * dp) else min(120 * dp, ri * .4f)
    val small = side / dp < 480
    /** Start, end, and middle angle of each machine arc, in machine order. */
    val ranges = LinkedHashMap<String, Triple<Float, Float, Float>>()
    val angles = HashMap<String, Float>()
    /** The machine names and states, kept 12 dp or more inside the table (set by layoutTable). */
    var labels = emptyList<MachineLabel>()

    init {
        if (seated.isEmpty()) {
            // With no seats, each machine gets an equal arc, the first one centered at the top.
            val arc = if (machines.isEmpty()) 0f else (360f - 6 * machines.size) / machines.size
            var start = -90f - arc / 2
            for (machine in machines) {
                ranges[machine.machineId] = Triple(start, start + arc, start + arc / 2)
                start += arc + 6
            }
        } else {
            val withSeats = machines.filter { m -> seated.any { it.machineId == m.machineId } }
            val slot = (360f - 6 * withSeats.size) / seated.size
            var start = -90f - (withSeats.firstOrNull()?.let { m -> seated.count { it.machineId == m.machineId } } ?: 0) * slot / 2
            for (machine in withSeats) {
                val seats = seated.filter { it.machineId == machine.machineId }
                ranges[machine.machineId] = Triple(start, start + seats.size * slot, start + seats.size * slot / 2)
                seats.forEachIndexed { j, seat -> angles[seat.id] = start + (j + .5f) * slot }
                start += seats.size * slot + 6
            }
        }
    }

    fun polar(r: Float, degrees: Float): Offset {
        val a = Math.toRadians(degrees.toDouble())
        return Offset(c.x + r * cos(a).toFloat(), c.y + r * sin(a).toFloat())
    }

    fun pin(id: String): Offset? = angles[id]?.let { polar(rp, it) }

    /** The chord of boards.html chordD: around the center disc on a large table. */
    fun curve(a: String, b: String, sameMachine: Boolean): Curve? {
        val p1 = pin(a) ?: return null
        val p2 = pin(b) ?: return null
        val mid = (p1 + p2) / 2f
        val distance = (mid - c).getDistance()
        val unit = if (distance > 1) (mid - c) / distance else {
            val t = Math.toRadians((angles.getValue(a) + 90).toDouble())
            Offset(cos(t).toFloat(), sin(t).toFloat())
        }
        val f = if (sameMachine) .775f else .625f
        val m = if (!small) max(rc + 24 * dp, f * distance) else f * distance
        val w = c + unit * m
        return Curve(p1, w * 2f - mid, p2)
    }
}

/** A machine name or state outside the band; [cos] and [sin] give its anchor direction. */
private class MachineLabel(val layout: TextLayoutResult, val x: Float, val y: Float, val cos: Float, val sin: Float) {
    val w get() = layout.size.width.toFloat()
    val h get() = layout.size.height.toFloat()
    val box get() = Rect(x, y, x + w, y + h)
}

/** The machine labels at the arc centers (the preview's drawRing labels); with [clamp], 12 dp or more inside the table. */
private fun machineLabels(geom: TableGeom, machines: List<ActivityMachine>, colors: ActivityColors, measurer: TextMeasurer,
    clamp: Boolean): List<MachineLabel> {
    val dp = geom.dp
    val edge = 12 * dp
    return machines.flatMap { machine ->
        val range = geom.ranges[machine.machineId] ?: return@flatMap emptyList()
        val anchor = geom.polar(geom.ro + 26 * dp, range.third)
        val cosA = cos(Math.toRadians(range.third.toDouble())).toFloat()
        val sinA = sin(Math.toRadians(range.third.toDouble())).toFloat()
        val dy = when { sinA < -.25f -> -8 * dp; sinA > .25f -> 8 * dp; else -> 0f }
        listOf(
            Triple(machine.name, TextStyle(color = colors.text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold), -7 * dp),
            Triple(machineStateText(machine), TextStyle(color = colors.muted, fontSize = 11.sp), 9 * dp),
        ).map { (text, style, offset) ->
            val layout = measurer.measure(text, style, maxLines = 1)
            val w = layout.size.width.toFloat()
            val h = layout.size.height.toFloat()
            var x = when { cosA > .25f -> anchor.x; cosA < -.25f -> anchor.x - w; else -> anchor.x - w / 2 }
            var y = anchor.y + dy + offset - h / 2
            if (clamp) {
                x = x.coerceIn(edge, max(edge, geom.side - edge - w))
                y = y.coerceIn(edge, max(edge, geom.side - edge - h))
            }
            MachineLabel(layout, x, y, cosA, sinA)
        }
    }
}

/** Port of label_overflow: how much smaller the ring must be so that each machine label is 12 dp or more inside the table. */
private fun labelOverflow(labels: List<MachineLabel>, side: Float, dp: Float): Float {
    var need = 0f
    for (l in labels) {
        for ((over, part) in listOf(12 * dp - l.x to abs(l.cos), l.x + l.w - (side - 12 * dp) to abs(l.cos),
            12 * dp - l.y to abs(l.sin), l.y + l.h - (side - 12 * dp) to abs(l.sin))) {
            // Along the anchor only: a label beside the anchor line moves with the clamp instead.
            if (over > 0 && part >= .25f) need = max(need, over / part)
        }
    }
    return need
}

/** Port of layout_table: a label nearer than 12 dp to an edge makes the ring smaller by the overflow, at most 4 times. */
private fun layoutTable(side: Float, dp: Float, seated: List<Seat>, machines: List<ActivityMachine>, colors: ActivityColors,
    measurer: TextMeasurer): TableGeom {
    var geom = TableGeom(side, dp, seated, machines)
    for (attempt in 1..3) {
        val need = labelOverflow(machineLabels(geom, machines, colors, measurer, clamp = false), side, dp)
        if (need <= .5f) break
        geom = TableGeom(side, dp, seated, machines, geom.shrink + need)
    }
    geom.labels = machineLabels(geom, machines, colors, measurer, clamp = true)
    return geom
}

/** A ring sector from [a0] to [a1] degrees; a full ring is two halves, as the preview draws it. */
internal fun sectorPath(c: Offset, r0: Float, r1: Float, a0: Float, a1: Float): Path = Path().apply {
    val parts = if (a1 - a0 >= 359.99f) listOf(a0 to a0 + 180, a0 + 180 to a0 + 360) else listOf(a0 to a1)
    for ((from, to) in parts) {
        arcTo(Rect(c, r1), from, to - from, true)
        if (r0 > 0) arcTo(Rect(c, r0), to, from - to, false) else lineTo(c.x, c.y)
        close()
    }
}

private val NEXT_PERIOD = mapOf("24h" to "7d", "7d" to "30d")

@Composable
private fun MessagesContent(
    reply: ActivityMessages, selected: String?, chordKey: String?, flights: List<Flight>, frameNanos: Long,
    colors: ActivityColors, bucket: Int?, strip: StripPlace, onBucket: (Int) -> Unit, onSeat: (String) -> Unit, onChord: (String) -> Unit,
    onClear: () -> Unit, onPeriod: (String) -> Unit,
) {
    val seats = remember(reply) { reply.seats.associateBy { it.id } }
    val machines = remember(reply) { reply.machines.associateBy { it.machineId } }
    val hues = remember(reply, colors) { reply.machines.mapIndexed { i, m -> m.machineId to colors.hue(i) }.toMap() }
    val seated = remember(reply, selected) { seatedSeats(reply, selected) }
    val chordList = remember(reply, seated) { chords(reply.messages, seated) }
    val counts = remember(reply) { seatCounts(reply.messages) }
    val ledger = remember(reply) { ledger(reply) }
    val selectedChord = chordList.firstOrNull { it.key == chordKey }
    val selectedSeat = selected?.takeIf { id -> seated.any { it.id == id } }
    val titles = remember(reply) { seatTitles(reply) }
    val title = { id: String -> titles[id] ?: UNLISTED }
    val busiest = remember(reply) { busiestPairs(reply) }
    val buckets = remember(reply) { messageBuckets(reply) }
    val partial = remember(reply) { messageBucketPartial(reply) }
    val labelMemory = remember { LabelMemory() }
    val marks = listOf("codex", "claude", "opencode", "").associateWith { painterResource(appMark(it)) }
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val palette = LocalPalette.current
    val machinesWithSeats = remember(reply) { activeSeats(reply).map { it.machineId }.distinct().size }
    val summary = "${plural(activeSeats(reply).size, "session")} on ${plural(machinesWithSeats, "machine")}, " +
        "${plural(ledger.total, "message")} in the last ${periodLabel(reply.period)}"
    // The neutral chord color (chords at rest and the count strip) for the background and the sector fills of the machines on the
    // table: the machines with seated seats, or all machines when none is seated.
    val gray = remember(reply, seated, palette, hues) {
        val fills = reply.machines.map { it.machineId }.filter { id -> seated.isEmpty() || seated.any { it.machineId == id } }.map { id ->
            mixColor(palette.background, hues.getValue(id).hex(), if (machineOffline(machines[id])) .03 else .05)
        }
        hexColor(chordGray(palette.background, palette.text, fills))
    }
    // As on the PC narrow layout, the Messages section stands above the table; an empty period shows only the table.
    // With no buckets in the reply, the strip does not show.
    if (ledger.total > 0) MessagesSummary(ledger, colors, if (buckets.isEmpty()) null else { ->
        CountStrip(buckets, reply.buckets.unit, partial, gray, colors, bucket, onBucket,
            Modifier.padding(bottom = 10.dp).onGloballyPositioned { strip.bounds = it.boundsInWindow() })
    })
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val sideDp = maxWidth - 16.dp
        val side = with(density) { sideDp.toPx() }
        val dp = density.density
        val geom = remember(side, seated, reply, colors, measurer) { layoutTable(side, dp, seated, reply.machines, colors, measurer) }
        Column {
            Box(Modifier.padding(horizontal = 8.dp)) {
                val curves = remember(geom, chordList) {
                    val nMax = max(1, chordList.maxOfOrNull { it.n } ?: 1)
                    chordList.associate { chord ->
                        chord.key to geom.curve(chord.a, chord.b, seats[chord.a]?.machineId == seats[chord.b]?.machineId)?.let { chordDraw(chord, it, nMax, dp) }
                    }
                }
                // A chosen seat or chord has priority over a chosen bucket, which lights the chords with a message in it.
                val inBucket = remember(reply, chordList, bucket) { bucket?.let { bucketPairCounts(reply, it, chordList) } }
                val lit = tableLit(chordList, selectedSeat, selectedChord, inBucket)
                val bucketName = bucket?.let { buckets.getOrNull(it) }?.let { stripBucketName(it.startMs, reply.buckets.unit) }
                // The selected seat and the two seats of the selected chord place first and show their whole label.
                val chosen = listOfNotNull(selectedSeat, selectedChord?.a, selectedChord?.b).distinct()
                val labelPx = with(density) { 12.sp.toPx() }
                val labels = remember(geom, curves, lit, chosen, bucketName, titles, colors, measurer, labelPx) {
                    tableLabels(reply, geom, seated, chordList, curves, machines, colors, measurer, dp, labelPx, titles, labelMemory, lit, chosen, bucketName)
                }
                // The words of the shown key parts are also the description of the table.
                val described = labels.key?.takeIf { labels.keyShown }?.let { "$summary. ${it.words}" } ?: summary
                val currentOnSeat by rememberUpdatedState(onSeat)
                val currentOnChord by rememberUpdatedState(onChord)
                val currentOnClear by rememberUpdatedState(onClear)
                Canvas(
                    Modifier.size(sideDp)
                        .semantics { contentDescription = described }
                        .pointerInput(geom, curves) {
                            detectTapGestures { point ->
                                val seat = seated.map { it.id }.minByOrNull { id -> geom.pin(id)?.let { (it - point).getDistance() } ?: Float.MAX_VALUE }
                                val seatDistance = seat?.let { geom.pin(it) }?.let { (it - point).getDistance() } ?: Float.MAX_VALUE
                                val chord = curves.entries.mapNotNull { (key, draw) -> draw?.let { key to it.curve.distanceTo(point) } }
                                    .minByOrNull { it.second }
                                when {
                                    seat != null && seatDistance <= 20 * dp -> currentOnSeat(seat)
                                    chord != null && chord.second <= 14 * dp -> currentOnChord(chord.first)
                                    else -> currentOnClear()
                                }
                            }
                        },
                ) {
                    drawTable(geom, seated, chordList, curves, machines, hues, lit, labels, flights, frameNanos, marks, colors, gray, dp)
                }
                // TalkBack reaches each seat in circle order; a tap selects it, as a tap on its pin.
                for (seat in seated) {
                    val pin = geom.pin(seat.id) ?: continue
                    val count = counts[seat.id]
                    val label = "${title(seat.id)}, ${appLabel(seat.app)}, ${machines[seat.machineId]?.name.orEmpty()}: " +
                        seatDirections(count)
                    Box(Modifier.offset { IntOffset((pin.x - 20 * dp).roundToInt(), (pin.y - 20 * dp).roundToInt()) }.size(40.dp)
                        .clickable(interactionSource = null, indication = null, role = Role.Button) { onSeat(seat.id) }
                        .clearAndSetSemantics { contentDescription = label; role = Role.Button })
                }
            }
            // The empty block sizes follow the width of the center disc.
            CenterPanel(reply, selectedSeat, selectedChord, counts, seats, machines, colors, title, 2 * geom.rc / dp, onPeriod)
        }
    }
    val seatedIds = seated.map { it.id }.toSet()
    if (ledger.total > 0) LedgerView(ledger, busiest, reply, hues, machines, colors, title) { pair ->
        // A tap selects the chord of a pair whose two sessions are seated, as a tap on the chord.
        if (pair.a in seatedIds && pair.b in seatedIds) onChord(pair.key)
    }
}

/** The seat labels and the key line of the table, placed in the composition so that TalkBack hears the shown key parts. */
private class TableLabels(val inputs: List<SeatLabelInput>, val spots: Map<String, SeatLabelSpot?>, val texts: Map<String, List<TextLayoutResult>>,
    val lines: List<ChordLine>, val key: KeyPlan?, val keyTexts: Map<String, TextLayoutResult>) {
    /** A chosen label without a free place can cover the key, which then hides. */
    val keyShown = key != null && key.shown && spots.values.none { it != null && it.box.overlaps(key.box) }
}

/** The ink box of [layout] from its top left: the ink of each line ([paint] at the label size) at its line start and baseline. */
private fun inkBox(layout: TextLayoutResult, paint: android.graphics.Paint): Rect {
    val text = layout.layoutInput.text.text
    var ink: Rect? = null
    for (line in 0 until layout.lineCount) {
        val part = text.substring(layout.getLineStart(line), layout.getLineEnd(line, visibleEnd = true))
        if (part.isBlank()) continue
        val bounds = android.graphics.Rect()
        paint.getTextBounds(part, 0, part.length, bounds)
        val left = layout.getLineLeft(line)
        val base = layout.getLineBaseline(line)
        val box = Rect(left + bounds.left, base + bounds.top, left + bounds.right, base + bounds.bottom)
        ink = ink?.let { Rect(min(it.left, box.left), min(it.top, box.top), max(it.right, box.right), max(it.bottom, box.bottom)) } ?: box
    }
    return ink ?: Rect(0f, 0f, layout.size.width.toFloat(), layout.size.height.toFloat())
}

private fun tableLabels(
    reply: ActivityMessages, geom: TableGeom, seated: List<Seat>, chordList: List<Chord>, curves: Map<String, ChordDraw?>,
    machines: Map<String, ActivityMachine>, colors: ActivityColors, measurer: TextMeasurer, dp: Float, labelPx: Float,
    titles: Map<String, String>, memory: LabelMemory, lit: TableLit, chosen: List<String>, bucketName: String?,
): TableLabels {
    val c = geom.c
    val size = Size(geom.side, geom.side)
    // The key line keeps off the pin squares and the machine labels.
    val pinBoxes = seated.mapNotNull { geom.pin(it.id) }.map { Rect(it, (16 + PIN_RING) * dp) }
    val others = pinBoxes + geom.labels.map { it.box }
    val keyStyle = TextStyle(color = colors.muted, fontSize = 11.sp)
    val keyTexts = HashMap<String, TextLayoutResult>()
    val measureKey = { text: String ->
        keyTexts.getOrPut(text) { measurer.measure(text, keyStyle, maxLines = 1) }.size.let { Size(it.width.toFloat(), it.height.toFloat()) }
    }
    val rest = listOf("bad" to "Not sent") + (if (chordList.any { it.mixed }) listOf("mixed" to "Some not sent") else emptyList()) +
        if (geom.ranges.keys.any { machineOffline(machines[it]) }) listOf("offline" to "Offline") else emptyList()
    val counts = lit.counts?.let { bucket -> chordList.map { bucket[it.key] ?: 0 } } ?: chordList.map { it.n }
    val key = planKey(counts, bucketName.takeIf { lit.counts != null }, rest, measureKey, dp, size.height) { box ->
        // It stays inside the table, outside the outer ring, and off the pins and the machine labels.
        val near = Offset(c.x.coerceIn(box.left, box.right), c.y.coerceIn(box.top, box.bottom))
        box.right <= size.width - 12 * dp && (near - c).getDistance() > geom.ro + 2 * dp && others.none { it.overlaps(box) }
    }
    // Seat labels (the PC place_labels): nine places each, with the whole text on one and on two lines, then cut to 10 and to 7
    // characters, then the late cuts, else none.
    val machineBoxes = geom.labels.map { Rect(it.box.left - 1 * dp, it.box.top, it.box.right + 1 * dp, it.box.bottom) }
    val labelStyle = TextStyle(color = colors.text, fontSize = 12.sp, textAlign = TextAlign.Center)
    val names = seated.associate { seat -> seat.id to seatLabelTexts(titles[seat.id] ?: UNLISTED) }
    val texts = names.mapValues { (_, list) -> list.map { measurer.measure(it, labelStyle, maxLines = 2) } }
    val paint = android.graphics.Paint().apply { textSize = labelPx; isAntiAlias = true }
    val messages = seatCounts(reply.messages).mapValues { it.value.sent + it.value.received }
    // Kept-off shapes: the own exits of each seat, by the rest width of their chord, and every all-not-sent chord.
    val exits = HashMap<String, MutableList<Pair<Float, List<Pair<Offset, Float>>>>>()
    for (chord in chordList) {
        val draw = curves[chord.key] ?: continue
        for ((id, start) in listOf(chord.a to true, chord.b to false)) {
            exits.getOrPut(id) { mutableListOf() } += draw.width to exitCircles(draw.curve.length, draw.curve::pointAtLength, start, draw.width, dp)
        }
    }
    val dashed = chordList.filter { it.bad }.flatMap { chord ->
        curves[chord.key]?.let { dashedCircles(it.curve.length, it.curve::pointAtLength, it.width, dp) }.orEmpty()
    }
    // The center lines of the chords at rest, for the chord ink under a plate (3 times for an all-not-sent chord).
    val lines = chordList.mapNotNull { chord ->
        curves[chord.key]?.let { ChordLine(chord.key, chord.a, chord.b, it.width, if (chord.bad) 3 else 1, it.curve.points) }
    }
    val inputs = seated.filter { it.id in geom.angles }.map { seat ->
        val own = exits[seat.id].orEmpty()
        val widest = own.maxOfOrNull { it.first }
        val list = names.getValue(seat.id)
        SeatLabelInput(seat.id, geom.angles.getValue(seat.id), texts.getValue(seat.id).map { Size(it.size.width.toFloat(), it.size.height.toFloat()) },
            seatLabelWholeCount(list), pinCircle(geom.pin(seat.id)!!, dp), own.flatMap { it.second },
            own.filter { it.first == widest }.flatMap { it.second }, seatLabelLate(list, titles[seat.id] ?: UNLISTED),
            texts.getValue(seat.id).map { inkBox(it, paint) })
    }
    // The pins and the not-sent end points are circles (the key line keeps the pin squares).
    val pinCircles = seated.mapNotNull { geom.pin(it.id) }.map { pinCircle(it, dp) }
    val circles = curves.values.filterNotNull().flatMap { draw -> draw.ends.flatten().map { endCircle(it, draw.endWidth, dp) } }
    val blocked = machineBoxes + listOfNotNull(key?.box?.takeIf { key.shown })
    // A selection change keeps the labels that are still free; a period change, other seats, or another size places from the start.
    val reset = listOf(reply.period, seated.map { it.id }, size)
    val spots = placeSeatLabels(inputs, chosen, messages, activityTimes(reply.messages),
        LabelTable(c, geom.rp, geom.rc, !geom.small, size.width, size.height, blocked, geom.ri, geom.ro, circles, pinCircles, dashed, lines), dp,
        lit.pins - chosen.toSet(), if (memory.reset == reset) memory.spots else emptyMap(), lit.chords)
    memory.reset = reset
    memory.spots = spots
    return TableLabels(inputs, spots, texts, lines, key, keyTexts)
}

private fun DrawScope.drawTable(
    geom: TableGeom, seated: List<Seat>, chordList: List<Chord>, curves: Map<String, ChordDraw?>,
    machines: Map<String, ActivityMachine>, hues: Map<String, Color>, lit: TableLit, labels: TableLabels,
    flights: List<Flight>, frameNanos: Long, marks: Map<String, Painter>, colors: ActivityColors, gray: Color, dp: Float,
) {
    if (geom.ranges.isEmpty()) return
    val c = geom.c
    val background = colors.background
    val dash = PathEffect.dashPathEffect(floatArrayOf(4 * dp, 3 * dp))
    val r0 = if (geom.small) 0f else geom.rc
    fun tint(id: String) = hues[id]?.copy(alpha = if (machineOffline(machines[id])) .03f else .05f)
    // An offline sector draws no dashed radial edges: its dashed band, its dashed pin rings, and its Offline label say it.
    for ((id, range) in geom.ranges) tint(id)?.let { drawPath(sectorPath(c, r0, geom.ri, range.first, range.second), it) }
    for ((id, range) in geom.ranges) {
        val hue = hues[id] ?: continue
        if (machineOffline(machines[id])) {
            // A row of about 12 dp dashes with 4 dp gaps.
            val color = hexColor(offlineBandColor(background.hex(), hue.hex()))
            for ((start, end) in offlineDashes(geom.ri, geom.ro, range.first, range.second, dp)) drawPath(sectorPath(c, geom.ri, geom.ro, start, end), color)
        } else drawPath(sectorPath(c, geom.ri, geom.ro, range.first, range.second), hue.copy(alpha = .85f))
    }
    // Chords: at rest one neutral gray; a selection lights its chords in the accent, and the others mix 35% toward the background.
    val lighting = lit.lighting
    val flying = if (lighting) emptySet() else flights.filter { it.startNanos <= frameNanos }.mapNotNull { pairKey(it.message, seated) }.toSet()
    val bad = statusColor("not-sent", colors)
    val dimGray = mixToward(background, gray, .35)
    val dimBad = mixToward(background, bad, .35)
    val badDash = PathEffect.dashPathEffect(floatArrayOf(5 * dp, 5 * dp))
    val endDash = PathEffect.dashPathEffect(floatArrayOf(4 * dp, 3 * dp))
    val largest = lit.counts?.values?.maxOrNull() ?: 1
    // Port of snapshot_chord: part is "casing", "stroke", or "ends" for the three passes of the lit chords, else "all".
    fun drawChord(chord: Chord, draw: ChordDraw, part: String) {
        val isLit = chord.key in lit.chords
        val dim = !isLit && (lighting || (flying.isNotEmpty() && chord.key !in flying))
        // A selection never recolors a not-sent mark: a lit all-not-sent chord stays dashed in the not-sent color, 3 dp wide.
        val color = when {
            chord.bad -> if (dim) dimBad else bad
            isLit -> colors.accent
            else -> if (dim) dimGray else gray
        }
        // A chord lit by a chosen bucket has the width of its count there (status_chord_width).
        val count = lit.counts?.get(chord.key) ?: 0
        val width = when {
            chord.bad -> if (isLit) 3 * dp else draw.width
            isLit && count > 0 -> statusChordWidth(count, largest) * dp
            else -> draw.width
        }
        if (isLit && part in setOf("all", "casing")) drawPath(draw.curve.path, background, style = Stroke(width + 2 * dp, cap = StrokeCap.Round))
        if (part in setOf("all", "stroke") && draw.drawn(width, dp).let { it.second > it.first }) {
            // An all-not-sent chord: 5 dp on and 5 dp off with butt caps.
            drawPath(draw.stroke(width, dp), color, style = if (chord.bad) Stroke(width, cap = StrokeCap.Butt, pathEffect = badDash)
                else Stroke(width, cap = StrokeCap.Round))
        }
        // A mixed pair: each receiver end with not-sent messages is 3 dp, 4 dp on and 3 dp off from the rim, with butt caps, in the
        // not-sent color over a casing 2 dp wider.
        if (part in setOf("all", "casing")) for (end in draw.ends) drawPath(polyline(end), background, style = Stroke(draw.endWidth + 2 * dp))
        if (part in setOf("all", "ends")) for (end in draw.ends) {
            drawPath(polyline(end), if (dim) dimBad else bad, style = Stroke(draw.endWidth, pathEffect = endDash))
        }
    }
    fun drawLit(keys: Set<String>) {
        // The lit chords draw last, so that no chord crosses them: all casings, then all strokes, then all not-sent dashes.
        for (part in listOf("casing", "stroke", "ends")) {
            for (chord in chordList) if (chord.key in keys) curves[chord.key]?.let { drawChord(chord, it, part) }
        }
    }
    for (chord in chordList) if (chord.key !in lit.chords) curves[chord.key]?.let { drawChord(chord, it, "all") }
    drawLit(lit.chords)
    if (!geom.small) drawCircle(background, geom.rc, c)
    if (!geom.small) drawCircle(colors.rule, geom.rc, c, style = Stroke(1 * dp))
    // Lights: glow, a tail of 8 circles over the last 20% of the elapsed time, and the head.
    for (flight in flights) {
        val key = pairKey(flight.message, seated) ?: continue
        val curve = curves[key]?.curve ?: continue
        val elapsed = (frameNanos - flight.startNanos) / 1_000_000f
        if (elapsed < 0) continue
        val end = if (flight.notSent) .85f else 1f
        val forward = chordList.firstOrNull { it.key == key }?.a == flight.message.from
        val at = { ms: Float ->
            val s = FlightEasing.transform((ms / FLIGHT_MS).coerceIn(0f, 1f)) * end
            curve.pointAtLength(if (forward) s else 1 - s)
        }
        val e = min(elapsed, FLIGHT_MS.toFloat())
        val fade = if (elapsed > FLIGHT_MS) 1 - (elapsed - FLIGHT_MS) / FADE_MS else 1f
        if (fade <= 0) continue
        val head = at(e)
        drawCircle(GLOW, 6 * dp, head, alpha = .25f * fade)
        for (i in 7 downTo 0) {
            drawCircle(LIGHT, (2.6f - 2 * i / 7f) * dp, at(max(0f, e - (i + 1) / 8f * .2f * e)), alpha = (.5f - .45f * i / 7f) * fade)
        }
        drawCircle(LIGHT, 3 * dp, head, alpha = fade)
    }
    val inputs = labels.inputs.associateBy { it.id }
    fun plate(id: String, spot: SeatLabelSpot): Rect = labelPlate(spot.box, inputs.getValue(id).inks[spot.text], dp)
    fun clipPlate(rect: Rect, block: DrawScope.() -> Unit) =
        clipPath(Path().apply { addRoundRect(RoundRect(rect, CornerRadius(3 * dp))) }, block = block)
    // While the table dims, the labels of seats that are not lit draw in the muted color.
    fun textColor(id: String) = if (lighting && id !in lit.pins) colors.muted else colors.text
    for ((id, spot) in labels.spots) {
        if (spot == null) continue
        // The plate: the table draws its background again in it (the background, each sector tint, and the center disc with its rule),
        // so no chord at rest and no dim chord shows under the label.
        clipPlate(plate(id, spot)) {
            drawRect(background)
            for ((machine, range) in geom.ranges) tint(machine)?.let { drawPath(sectorPath(c, r0, geom.ri, range.first, range.second), it) }
            if (!geom.small) {
                drawCircle(background, geom.rc, c)
                drawCircle(colors.rule, geom.rc, c, style = Stroke(1 * dp))
            }
        }
        drawText(labels.texts.getValue(id)[spot.text], color = textColor(id), topLeft = Offset(spot.box.left + 1 * dp, spot.box.top))
    }
    // A lit chord draws again over the plates that it crosses, and those labels draw again over a casing.
    for ((id, keys) in plateCrossings(labels.spots, labels.inputs, labels.lines, lit.chords, dp)) {
        val spot = labels.spots[id] ?: continue
        clipPlate(plate(id, spot)) { drawLit(keys.toSet()) }
        drawCasedText(labels.texts.getValue(id)[spot.text], Offset(spot.box.left + 1 * dp, spot.box.top), background, textColor(id), dp)
    }
    // Pins are opaque: the background fill, then the ring, after all chords and not-sent ends. A lit pin has a 2 dp accent ring with a
    // 1 dp background casing on each side; the others mix toward the background. An offline pin has a dashed ring in every state.
    for (seat in seated) {
        val pin = geom.pin(seat.id) ?: continue
        val offline = machineOffline(machines[seat.machineId])
        val hue = hues[seat.machineId] ?: colors.text
        val chosen = seat.id in lit.pins
        val dim = if (lighting && !chosen) .35 else 1.0
        val factor = (if (offline) .75 else 1.0) * dim
        val ring = if (offline) PathEffect.dashPathEffect(floatArrayOf(4 * dp, 3 * dp)) else null
        drawCircle(background, 16 * dp, pin)
        if (chosen) {
            drawCircle(background, 16 * dp, pin, style = Stroke(4 * dp))
            drawCircle(colors.accent, 16 * dp, pin, style = Stroke(2 * dp, pathEffect = ring))
        } else {
            // The rest ring of an offline pin: the machine hue moved toward the text until it has 3:1 on its sector tint.
            val rest = if (offline) hexColor(offlineRingColor(background.hex(), colors.text.hex(), hue.hex())) else hue
            drawCircle(mixToward(background, rest, dim), 16 * dp, pin, style = Stroke(1.5f * dp, pathEffect = ring))
        }
        val mark = marks[appKey(seat.app)] ?: continue
        translate(pin.x - 7 * dp, pin.y - 7 * dp) {
            // The app glyphs use the muted text color of the unlit seat labels.
            with(mark) { draw(Size(14 * dp, 14 * dp), colorFilter = ColorFilter.tint(mixToward(background, colors.muted, factor))) }
        }
    }
    for (label in geom.labels) drawText(label.layout, topLeft = Offset(label.x, label.y))
    // The Offline sample takes the hue of the offline machine, or the muted color when several machines are offline.
    val offline = geom.ranges.keys.filter { machineOffline(machines[it]) }
    val offlineColor = offline.singleOrNull()?.let { hues[it] } ?: colors.muted
    labels.key?.takeIf { labels.keyShown }?.let { drawKey(it, labels.keyTexts, colors, gray, offlineColor, geom.ro - geom.ri, dp) }
}

/** The last seat label placement, kept while the period, the seated seats, and the size stay the same. */
private class LabelMemory {
    var reset: Any? = null
    var spots: Map<String, SeatLabelSpot?> = emptyMap()
}

/**
 * Port of snapshot_cased_text: the text of a label that a lit chord crosses, over a 2 dp casing in the [casing] color: the text at
 * 24 offsets (16 at 2 dp, 8 at 1 dp), which rounds the corners as a round join does, then the text in [color].
 */
private fun DrawScope.drawCasedText(layout: TextLayoutResult, topLeft: Offset, casing: Color, color: Color, dp: Float) {
    for ((radius, steps) in listOf(2f to 16, 1f to 8)) {
        for (step in 0 until steps) {
            val angle = 2 * Math.PI * step / steps
            drawText(layout, color = casing, topLeft = topLeft + Offset(radius * dp * cos(angle).toFloat(), radius * dp * sin(angle).toFloat()))
        }
    }
    drawText(layout, color = color, topLeft = topLeft)
}

/** Port of snapshot_key; [band] is the width of the machine band. */
private fun DrawScope.drawKey(key: KeyPlan, texts: Map<String, TextLayoutResult>, colors: ActivityColors, gray: Color, offline: Color,
    band: Float, dp: Float) {
    val middle = key.middle
    val bad = statusColor("not-sent", colors)
    val dashes = PathEffect.dashPathEffect(floatArrayOf(5 * dp, 5 * dp))
    val endDash = PathEffect.dashPathEffect(floatArrayOf(4 * dp, 3 * dp))
    fun text(words: String, x: Float) = texts.getValue(words).let { drawText(it, topLeft = Offset(x, middle - it.size.height / 2f)) }
    for (item in key.items) {
        val left = item.x
        when (item.kind) {
            // Three 16 dp butt-capped samples at the widths of the smallest, the middle, and the largest count, each before its count.
            "scale" -> for (group in item.groups) {
                drawLine(gray, Offset(group.x, middle), Offset(group.x + 16 * dp, middle), group.width * dp, StrokeCap.Butt)
                text(group.text, group.tx)
            }
            // Two 16 dp butt-capped segments at the smallest and the largest width, 4 dp apart; in the accent for a chosen bucket.
            "chords" -> for ((start, width) in listOf(left to key.widths.first, left + 20 * dp to key.widths.second)) {
                drawLine(if (key.accent) colors.accent else gray, Offset(start, middle), Offset(start + 16 * dp, middle), width * dp, StrokeCap.Butt)
            }
            "bad" -> drawLine(bad, Offset(left, middle), Offset(left + 18 * dp, middle), 2 * dp, pathEffect = dashes)
            // A gray chord, a 2 dp gap, then a 3 dp dashed not-sent end over its casing in the background color, as on the table.
            "mixed" -> {
                drawLine(gray, Offset(left, middle), Offset(left + 6 * dp, middle), 2 * dp)
                drawLine(colors.background, Offset(left + 8 * dp, middle), Offset(left + 18 * dp, middle), 5 * dp)
                drawLine(bad, Offset(left + 8 * dp, middle), Offset(left + 18 * dp, middle), 3 * dp, pathEffect = endDash)
            }
            // A 20 dp straight piece of the offline band at its real width: two 8 dp dashes with a 4 dp gap.
            else -> for (start in listOf(left, left + 12 * dp)) {
                drawRect(hexColor(offlineBandColor(colors.background.hex(), offline.hex())), Offset(start, middle - band / 2), Size(8 * dp, band))
            }
        }
        text(item.text, item.tx)
    }
}

/** The chord key of a message between two seated seats, or null. */
private fun pairKey(message: ActivityMessage, seated: List<Seat>): String? {
    val i = seated.indexOfFirst { it.id == message.from }
    val j = seated.indexOfFirst { it.id == message.to }
    if (i < 0 || j < 0 || i == j) return null
    return if (i < j) "${message.from}|${message.to}" else "${message.to}|${message.from}"
}

@Composable
private fun CenterPanel(
    reply: ActivityMessages, seat: String?, chord: Chord?, counts: Map<String, SeatCount>, seats: Map<String, Seat>,
    machines: Map<String, ActivityMachine>, colors: ActivityColors, title: (String) -> String, disc: Float, onPeriod: (String) -> Unit,
) {
    HorizontalDivider(thickness = 1.dp, color = colors.divider)
    Column(Modifier.fillMaxWidth().background(colors.background).padding(horizontal = 16.dp, vertical = 10.dp)
        .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        verticalArrangement = Arrangement.spacedBy(3.dp)) {
        val route = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = colors.text)
        val newest = newestMessage(reply.messages)
        when {
            // TalkBack reads one part per direction, then the not-sent count.
            chord != null -> Column(Modifier.clearAndSetSemantics { contentDescription = chordText(chord, title) },
                verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("${title(chord.a)} ⇄ ${title(chord.b)}", style = route, maxLines = 2, overflow = TextOverflow.Ellipsis)
                for ((arrow, count, bad) in listOf(Triple("→", chord.ab, chord.badAb), Triple("←", chord.ba, chord.badBa))) {
                    Text("$arrow ${formatCount(count.toLong())}", fontSize = 14.sp, style = figures, color = colors.text)
                    NotSentCount(bad, colors)
                }
            }
            seat != null -> {
                val info = seats[seat]
                val count = counts[seat]
                Text(title(seat), fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = colors.text, maxLines = 1,
                    overflow = TextOverflow.Ellipsis)
                Text("${appLabel(info?.app.orEmpty())} · ${machines[info?.machineId]?.name.orEmpty()}", fontSize = 12.sp,
                    color = colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                    for ((label, value, bad) in listOf(Triple("Outgoing", count?.sent ?: 0, count?.badSent ?: 0),
                        Triple("Incoming", count?.received ?: 0, count?.badReceived ?: 0))) {
                        Column {
                            Text(label, fontSize = 11.sp, color = colors.muted)
                            Text(formatCount(value.toLong()), fontSize = 18.sp, style = figures, color = colors.text)
                            NotSentCount(bad, colors)
                        }
                    }
                }
            }
            newest != null -> {
                Text("Newest message", fontSize = 11.sp, color = colors.muted)
                Text("${title(newest.from)} → ${title(newest.to)}", style = route, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(buildAnnotatedString {
                    append("${messageTime(newest.atMs, reply.nowMs.takeIf { it > 0 } ?: System.currentTimeMillis(), reply.period)} · ")
                    withStyle(SpanStyle(color = statusWordColor(newest.status, colors))) {
                        append(messageStatusLabel(newest, seats, reply.machines))
                    }
                }, fontSize = 11.sp, style = figures, color = colors.muted)
            }
            // The block of the Usage empty page: the icon, the title, the hint, and the pill; larger from a 520 dp disc.
            else -> Column(Modifier.fillMaxWidth().padding(vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp),
                horizontalAlignment = Alignment.CenterHorizontally) {
                val (icon, titleSp) = emptyBlockSizes(disc)
                EmptyBlock(R.drawable.ic_messages, "No messages in the last ${periodLabel(reply.period)}", MESSAGES_EMPTY_HINT, colors,
                    icon.dp, titleSp)
                NEXT_PERIOD[reply.period]?.let { next ->
                    AccentButton("Show the last ${periodLabel(next)}", colors, Modifier.padding(top = 4.dp)) { onPeriod(next) }
                }
            }
        }
    }
}

/** `1 not sent` (12 sp) in the not-sent status word color, under a count; nothing when [count] is 0. */
@Composable
private fun NotSentCount(count: Int, colors: ActivityColors) {
    if (count > 0) Text("${formatCount(count.toLong())} not sent", fontSize = 12.sp, style = figures, color = statusWordColor("not-sent", colors))
}

/** The empty page block: a muted [iconSize] icon, the [titleSp] bold title (at most 2 lines), and the hint (at most 260 dp wide). */
@Composable
internal fun EmptyBlock(icon: Int, title: String, hint: String, colors: ActivityColors, iconSize: Dp = 64.dp, titleSp: Int = 20) {
    Icon(painterResource(icon), contentDescription = null, tint = colors.muted, modifier = Modifier.size(iconSize))
    Text(title, fontSize = titleSp.sp, fontWeight = FontWeight.Bold, color = colors.text, textAlign = TextAlign.Center, maxLines = 2,
        overflow = TextOverflow.Ellipsis)
    Text(hint, fontSize = 12.sp, color = colors.muted, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 260.dp))
}

/** A filled pill button in the accent, with the background as its content color (the PC suggested-action pill). */
@Composable
internal fun AccentButton(text: String, colors: ActivityColors, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Button(onClick = onClick, modifier = modifier, shape = CircleShape,
        colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.background)) { Text(text) }
}

/** The Messages section: the total with the not-sent count, the status bar, the [strip] (6 dp under the bar), and the legend. */
@Composable
private fun MessagesSummary(ledger: Ledger, colors: ActivityColors, strip: (@Composable () -> Unit)?) {
    Column(Modifier.fillMaxWidth().background(colors.background).padding(start = 18.dp, end = 18.dp, top = 16.dp, bottom = 16.dp)) {
        SectionTitle("Messages", colors)
        val notSent = ledger.byStatus.firstOrNull { it.first == "not-sent" }?.second ?: 0
        val totalName = plural(ledger.total, "message") + if (notSent > 0) ", ${formatCount(notSent.toLong())} not sent" else ""
        // The total, and after it on its baseline the not-sent count.
        Row(Modifier.clearAndSetSemantics { contentDescription = totalName }, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(formatCount(ledger.total.toLong()), fontSize = 30.sp, lineHeight = 42.sp, style = figures,
                fontWeight = FontWeight.Bold, color = colors.text, modifier = Modifier.alignByBaseline())
            if (notSent > 0) {
                Row(Modifier.alignByBaseline(), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    StatusIcon("not-sent", statusTextColor("not-sent", colors), 14.dp)
                    Text("${formatCount(notSent.toLong())} not sent", fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                        color = statusWordColor("not-sent", colors),
                        style = figures)
                }
            }
        }
        val shown = ledger.byStatus.filter { it.second > 0 }
        Row(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = if (strip != null) 6.dp else 10.dp).height(8.dp)
            .clearAndSetSemantics { contentDescription = shown.joinToString(", ") { "${statusLabel(it.first)} ${it.second}" } },
            horizontalArrangement = Arrangement.spacedBy(1.dp)) {
            for ((status, count) in shown) {
                Box(Modifier.weight(count.toFloat()).widthIn(min = 2.dp).height(8.dp)
                    .background(statusColor(status, colors), RoundedCornerShape(2.dp)))
            }
        }
        // The legend follows 10 dp under the strip, or 10 dp under the bar.
        strip?.invoke()
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            for ((status, count) in shown) {
                // The usual outcomes are quiet; the ones to look at keep the text color.
                val tone = if (status == "accepted" || status == "written") colors.muted else colors.text
                Row(Modifier.fillMaxWidth().clearAndSetSemantics {
                    contentDescription = "${statusLabel(status)}, ${formatCount(count.toLong())}. ${STATUS_TIPS.getValue(status)}"
                }, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(8.dp).background(statusColor(status, colors), RoundedCornerShape(2.dp)))
                    Text(statusLabel(status), fontSize = 12.sp, color = tone, modifier = Modifier.weight(1f))
                    Text(formatCount(count.toLong()), fontSize = 12.sp, style = figures, color = tone)
                }
            }
        }
    }
}

/**
 * Port of CountStrip: messages over time, a 24 dp plot (3 dp insets) over a 16 dp tick row. A 2 dp line in the rest chord [gray]
 * joins the bucket points, each on a device pixel center, over a 1 dp baseline in the rule color at the y of count 0; a bucket with
 * a not-sent message has a dot in the not-sent color (3 dp, or 2 dp when two buckets are less than 14 dp apart). The line is the
 * monotone cubic curve of the Usage chart. When the last bucket is the current one ([partial]), the segment into it is dashed, its
 * point is a hollow ring, and a not-sent mark on it is a ring. The tick row names the first and the last bucket with a caption
 * between them; while a bucket is [chosen] (a tap or a drag chooses the nearest one), which has a 1 dp muted line and a dot at its
 * point, its readout stands in place of the caption.
 */
@Composable
private fun CountStrip(buckets: List<BucketCount>, unit: String, partial: Boolean, gray: Color, colors: ActivityColors, chosen: Int?,
    onChoose: (Int) -> Unit, modifier: Modifier = Modifier) {
    val measurer = rememberTextMeasurer()
    val style = TextStyle(fontSize = 11.sp, color = colors.muted)
    val bad = statusColor("not-sent", colors)
    val name = "Messages per ${if (unit == "hour") "hour" else "day"}"
    val tip = chosen?.let { index ->
        buckets.getOrNull(index)?.let { messageBucketTip(it.startMs, it.count, it.bad, unit, partial && index == buckets.lastIndex) }
    }
    val readout = chosen?.let { index ->
        buckets.getOrNull(index)?.let { messageBucketReadout(it.startMs, it.count, it.bad, unit, partial && index == buckets.lastIndex) }
    }
    val readoutStyle = TextStyle(fontSize = 11.sp, color = colors.text)
    val currentChoose by rememberUpdatedState(onChoose)
    Canvas(modifier.fillMaxWidth().height(40.dp)
        .clearAndSetSemantics { contentDescription = listOfNotNull(name, tip).joinToString(", ") }
        .pointerInput(buckets.size) {
            detectTapGestures { at -> stripBucketAt(at.x, buckets.size, size.width.toFloat(), 3.dp.toPx())?.let(currentChoose) }
        }
        .pointerInput(buckets.size) {
            val pick = { x: Float -> stripBucketAt(x, buckets.size, size.width.toFloat(), 3.dp.toPx())?.let(currentChoose) }
            detectHorizontalDragGestures(onDragStart = { pick(it.x) }) { change, _ -> pick(change.position.x) }
        }) {
        val dp = density
        val inset = 3 * dp
        val plot = 24 * dp
        val largest = buckets.maxOf { it.count }
        val points = buckets.mapIndexed { i, b ->
            Offset(pixelCenter(stripX(i, buckets.size, size.width, inset)), pixelCenter(stripY(b.count, largest, plot, inset)))
        }
        val current = partial && points.size > 1
        // The zero baseline under the line, as the Usage chart baseline.
        val zero = pixelCenter(stripY(0, largest, plot, inset))
        drawLine(colors.rule, Offset(points.first().x, zero), Offset(points.last().x, zero), 1 * dp)
        val point = chosen?.let { points.getOrNull(it) }
        if (point != null) drawLine(colors.muted, Offset(point.x, 0f), Offset(point.x, plot), 1 * dp)
        // The monotone cubic curve of the Usage chart through the points; the segment into the current bucket is dashed.
        val segments = smoothCurve(points)
        fun curve(parts: List<List<Offset>>) = Path().apply {
            moveTo(parts[0][0].x, parts[0][0].y)
            for ((_, c1, c2, to) in parts) cubicTo(c1.x, c1.y, c2.x, c2.y, to.x, to.y)
        }
        val solid = if (current) segments.dropLast(1) else segments
        if (solid.isNotEmpty()) drawPath(curve(solid), gray, style = Stroke(2 * dp, cap = StrokeCap.Round, join = StrokeJoin.Round))
        if (current) {
            // The current bucket is not complete: a dashed segment into a hollow point.
            drawPath(curve(segments.takeLast(1)), gray, style = Stroke(2 * dp, cap = StrokeCap.Butt,
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(3 * dp, 3 * dp))))
            drawCircle(colors.background, 3 * dp, points.last())
            drawCircle(gray, 3 * dp, points.last(), style = Stroke(1.5f * dp))
        }
        val dot = stripDotRadius(buckets.size, size.width, inset, dp)
        points.zip(buckets).forEachIndexed { i, (p, b) ->
            if (b.bad == 0) return@forEachIndexed
            if (current && i == points.lastIndex) {
                // A not-sent mark on the current bucket: a ring of the dot radius in the not-sent color, the background inside.
                drawCircle(colors.background, dot, p)
                drawCircle(bad, dot, p, style = Stroke(1.5f * dp))
            } else drawCircle(bad, dot, p)
        }
        if (chosen != null && point != null) {
            // A not-sent dot keeps its color and gets a 1 dp ring in the text color; another bucket gets a dot over a 1 dp casing.
            if (buckets[chosen].bad > 0) drawCircle(colors.text, 3.5f * dp, point, style = Stroke(1 * dp))
            else {
                drawCircle(colors.background, 4 * dp, point)
                drawCircle(colors.text, 3 * dp, point)
            }
        }
        val top = plot + 2 * dp
        val first = measurer.measure(stripFirstName(buckets.first().startMs, buckets.last().startMs, unit), style, maxLines = 1)
        val last = measurer.measure(stripBucketName(buckets.last().startMs, unit), style, maxLines = 1)
        val lastLeft = size.width - last.size.width
        // While a bucket is chosen, its readout stands in place of the caption, in the text color; when it does not fit between the
        // end names (12 dp from each), the end names hide, and then it ellipsizes at its end.
        val readoutPlace = readout?.let { words ->
            val whole = measurer.measure(words, readoutStyle, maxLines = 1)
            val (ends, x) = stripReadoutPlace(whole.size.width.toFloat(), first.size.width.toFloat(), lastLeft, size.width, buckets.size > 1, dp)
            Triple(if (ends || whole.size.width <= size.width) whole else measurer.measure(words, readoutStyle, maxLines = 1,
                overflow = TextOverflow.Ellipsis, constraints = androidx.compose.ui.unit.Constraints(maxWidth = size.width.toInt())), ends, x)
        }
        if (readoutPlace != null) {
            val (layout, ends, x) = readoutPlace
            if (ends) {
                drawText(first, topLeft = Offset(0f, top))
                drawText(last, topLeft = Offset(lastLeft, top))
            }
            drawText(layout, topLeft = Offset(x, top))
        } else {
            drawText(first, topLeft = Offset(0f, top))
            if (buckets.size > 1) {
                drawText(last, topLeft = Offset(lastLeft, top))
                // The caption, centered between the names with 12 dp from each; the not-sent part goes first when it does not fit.
                val per = measurer.measure(if (unit == "hour") "per hour" else "per day", style, maxLines = 1)
                val dot = measurer.measure(" · ", style, maxLines = 1)
                val notSent = measurer.measure(" not sent", style, maxLines = 1)
                val rest = dot.size.width + 6 * dp + notSent.size.width
                val left = first.size.width.toFloat()
                val parts = stripCaptionParts(left, lastLeft, per.size.width.toFloat(), rest, buckets.any { it.bad > 0 }, dp)
                if (parts > 0) {
                    val total = per.size.width + if (parts == 2) rest else 0f
                    var x = left + 12 * dp + (lastLeft - left - 24 * dp - total) / 2
                    drawText(per, topLeft = Offset(x, top))
                    if (parts == 2) {
                        x += per.size.width
                        drawText(dot, topLeft = Offset(x, top))
                        x += dot.size.width
                        drawCircle(bad, 3 * dp, Offset(x + 3 * dp, top + per.size.height / 2f))
                        drawText(notSent, topLeft = Offset(x + 6 * dp, top))
                    }
                }
            }
        }
    }
}

/** A 3 dp accent share bar of [fraction] over the bar track, from [left] to the right edge, with a 1 dp background gap between them. */
private fun DrawScope.drawShareBar(left: Float, top: Float, fraction: Float, colors: ActivityColors) {
    val width = size.width - left
    val height = 3 * density
    val f = fraction.coerceIn(0f, 1f)
    val corner = CornerRadius(1.5f * density)
    val start = trackStart(width, f, 1 * density)
    if (start < width) drawRoundRect(colors.track, Offset(left + start, top), Size(width - start, height), corner)
    if (f > 0) drawRoundRect(colors.accent, Offset(left, top), Size(width * f, height), corner)
}

/** Where the last text line of a barred row is: the row, the text, and its layout. The bar stands 4 dp under its descender line. */
private class BarLine {
    var row by mutableStateOf<LayoutCoordinates?>(null)
    var text by mutableStateOf<LayoutCoordinates?>(null)
    var layout by mutableStateOf<TextLayoutResult?>(null)

    /** The y in the row of the descender line of the last text line, for a [fontPx] text; null before the layout. */
    fun descender(fontPx: Float): Float? {
        val row = row?.takeIf { it.isAttached } ?: return null
        val text = text?.takeIf { it.isAttached } ?: return null
        val layout = layout ?: return null
        val descent = android.graphics.Paint().apply { textSize = fontPx }.fontMetrics.descent
        return row.localPositionOf(text, Offset(0f, layout.getLineBaseline(layout.lineCount - 1) + descent)).y
    }
}

/**
 * A ledger row with a share bar of [fraction] 4 dp under the descender line of its last text line ([line], a [fontSp] text), from
 * [barStart] to the row end; the 6 dp under the content keep the row pitch, and the rest of the row is under the bar.
 */
@Composable
private fun BarredRow(fraction: Float, colors: ActivityColors, line: BarLine, fontSp: Int, modifier: Modifier = Modifier,
    barStart: Dp = 0.dp, content: @Composable () -> Unit) {
    Column(modifier.fillMaxWidth().onGloballyPositioned { line.row = it }.drawBehind {
        line.descender(fontSp.sp.toPx())?.let { drawShareBar(barStart.toPx(), it + 4.dp.toPx(), fraction, colors) }
    }.padding(bottom = 6.dp)) { content() }
}

/** The ledger under the table: Recent, Busiest pairs, Between machines, and Between apps. */
@Composable
private fun LedgerView(
    ledger: Ledger, busiest: List<BusyPair>, reply: ActivityMessages, hues: Map<String, Color>,
    machines: Map<String, ActivityMachine>, colors: ActivityColors, title: (String) -> String, onPair: (BusyPair) -> Unit,
) {
    HorizontalDivider(thickness = 1.dp, color = colors.divider)
    Column(Modifier.fillMaxWidth().background(colors.background).padding(start = 18.dp, end = 18.dp, top = 16.dp, bottom = 28.dp)) {
        SectionTitle("Recent", colors)
        val now = reply.nowMs.takeIf { it > 0 } ?: System.currentTimeMillis()
        val timeStyle = figures.merge(TextStyle(fontSize = 12.sp, color = colors.muted))
        val times = ledger.recent.map { messageTime(it.atMs, now, reply.period) }
        // The time column is as wide as its widest label, so all routes start at one x.
        val measurer = rememberTextMeasurer()
        val timeWidth = with(LocalDensity.current) { (times.maxOfOrNull { measurer.measure(it, timeStyle, maxLines = 1).size.width } ?: 0).toDp() }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            ledger.recent.forEachIndexed { index, message ->
                Row(Modifier.fillMaxWidth().height(24.dp).semantics(mergeDescendants = true) {},
                    horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(times[index], style = timeStyle, maxLines = 1, modifier = Modifier.widthIn(min = timeWidth))
                    Text("${title(message.from)} → ${title(message.to)}", fontSize = 12.sp, color = colors.text, maxLines = 1,
                        overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    // The usual outcome has no mark.
                    if (statusKey(message.status) != "accepted") StatusIcon(message.status, statusTextColor(message.status, colors), 14.dp, label = true)
                }
            }
        }
        LedgerRule(colors)
        SectionTitle("Busiest pairs", colors)
        // Each bar fills its count over the period total (D14 A).
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            for (pair in busiest) BusyPairRow(pair, shareFill(pair.n, ledger.total), title, colors) { onPair(pair) }
        }
        LedgerRule(colors)
        SectionTitle("Between machines", colors)
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            for (row in ledger.machineRows) {
                val share = shareFill(row.count, ledger.total)
                val label = if (row.machineIds.size > 1) row.label else "Within ${row.label}"
                val line = remember { BarLine() }
                // The bar starts under the name: after the two-dot slot (two 7 dp dots, 3 dp apart) and the 6 dp row gap.
                BarredRow(share, colors, line, 12, Modifier.clearAndSetSemantics {
                    contentDescription = "$label, ${plural(row.count, "message")}, ${shareWords(share)}"
                }, barStart = 23.dp) {
                Row(Modifier.fillMaxWidth().heightIn(min = 24.dp), horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                        for (id in row.machineIds) MachineDot(hues[id] ?: colors.text, machineOffline(machines[id]))
                        // The empty place of a second dot: all names start at one x.
                        if (row.machineIds.size == 1) Spacer(Modifier.width(7.dp))
                    }
                    Text(label, fontSize = 12.sp, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        onTextLayout = { line.layout = it }, modifier = Modifier.weight(1f).onGloballyPositioned { line.text = it })
                    Text(formatCount(row.count.toLong()), fontSize = 12.sp, style = figures, color = colors.text)
                }
                }
            }
        }
        LedgerRule(colors)
        SectionTitle("Between apps", colors)
        AppMatrix(ledger, colors)
    }
}

/**
 * A Busiest pairs row: the route with each name ellipsized in the middle and the count; a not-sent line 2 dp under the route when the
 * pair has some; and a share bar of [share] (of all messages) 4 dp under the descender line of the last line.
 */
@Composable
private fun BusyPairRow(pair: BusyPair, share: Float, title: (String) -> String, colors: ActivityColors, onClick: () -> Unit) {
    val a = title(pair.a)
    val b = title(pair.b)
    val spoken = "$a and $b, ${plural(pair.n, "message")}" + (if (pair.bad > 0) ", ${formatCount(pair.bad.toLong())} not sent" else "") +
        ", ${shareWords(share)}"
    val line = remember { BarLine() }
    // The last text line: the not-sent line (11 sp) when the pair has one, else the route (12 sp).
    val last = { font: Int -> Modifier.onGloballyPositioned { line.text = it }.takeIf { (pair.bad > 0) == (font == 11) } ?: Modifier }
    val layout = { font: Int -> { it: TextLayoutResult -> if ((pair.bad > 0) == (font == 11)) line.layout = it } }
    BarredRow(share, colors, line, if (pair.bad > 0) 11 else 12,
        Modifier.clickable(onClick = onClick).clearAndSetSemantics { contentDescription = spoken; role = Role.Button }) {
        Row(Modifier.fillMaxWidth().heightIn(min = 26.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                val name = Modifier.weight(1f, fill = false)
                Text(a, fontSize = 12.sp, color = colors.text, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, onTextLayout = layout(12),
                    modifier = name.then(last(12)))
                Text("⇄", fontSize = 12.sp, color = colors.text, maxLines = 1)
                Text(b, fontSize = 12.sp, color = colors.text, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = name)
            }
            Text(formatCount(pair.n.toLong()), fontSize = 12.sp, style = figures, color = colors.text)
        }
        if (pair.bad > 0) Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically) {
            StatusIcon("not-sent", statusWordColor("not-sent", colors), 12.dp)
            Text("${formatCount(pair.bad.toLong())} not sent", fontSize = 11.sp, style = figures, color = colors.muted, maxLines = 1,
                onTextLayout = layout(11), modifier = last(11))
        }
    }
}

@Composable
private fun LedgerRule(colors: ActivityColors) {
    Spacer(Modifier.height(18.dp))
    HorizontalDivider(thickness = 1.dp, color = colors.rule)
    Spacer(Modifier.height(18.dp))
}

@Composable
private fun AppMatrix(ledger: Ledger, colors: ActivityColors) {
    val cell = Modifier.height(24.dp).padding(start = 4.dp)
    Column(Modifier.fillMaxWidth().semantics { contentDescription = "Messages from app (rows) to app (columns)" }) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("From → To", fontSize = 11.sp, color = colors.muted, maxLines = 1, modifier = Modifier.width(118.dp).then(cell))
            for (app in ledger.apps) {
                Box(Modifier.weight(1f).then(cell), contentAlignment = Alignment.CenterEnd) {
                    Icon(painterResource(appMark(app)), contentDescription = appLabel(app), tint = colors.muted, modifier = Modifier.size(14.dp))
                }
            }
        }
        ledger.apps.forEachIndexed { i, from ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.width(118.dp).then(cell), horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Icon(painterResource(appMark(from)), contentDescription = null, tint = colors.text, modifier = Modifier.size(14.dp))
                    Text(appLabel(from), fontSize = 12.sp, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                ledger.apps.forEachIndexed { j, to ->
                    val v = ledger.matrix[i][j]
                    Column(Modifier.weight(1f)) {
                        HorizontalDivider(thickness = 1.dp, color = colors.rule)
                        Box(Modifier.fillMaxWidth().then(cell).semantics {
                            contentDescription = "${appLabel(from)} to ${appLabel(to)}: ${if (v == 0) "none" else formatCount(v.toLong())}"
                        }, contentAlignment = Alignment.CenterEnd) {
                            Text(if (v == 0) "–" else formatCount(v.toLong()), fontSize = 12.sp, style = figures,
                                color = if (v == 0) colors.muted else colors.text)
                        }
                    }
                }
            }
        }
    }
}
