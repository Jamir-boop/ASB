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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.input.pointer.pointerInput
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
import local.asb.companion.data.BusyPair
import local.asb.companion.data.UNLISTED
import local.asb.companion.data.busiestPairs
import local.asb.companion.data.messageStatusLabel
import local.asb.companion.data.notSentCounts
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
    val statusWords: Map<String, Color>, val apps: Map<String, Color>, val hues: List<Color>, val tokens: Map<String, Color>) {
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
    // A selected disabled choice draws the track color with muted text, not the accent.
    val buttons = SegmentedButtonDefaults.colors(disabledActiveContainerColor = colors.track, disabledActiveContentColor = colors.muted,
        disabledInactiveContentColor = colors.muted)
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
            ) { Text(label, maxLines = 1) }
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
            Column(Modifier.widthIn(max = 840.dp).fillMaxWidth().verticalScroll(rememberScrollState())) {
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
                        MessagesContent(current, selected, chordKey, flights, frameNanos, colors,
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
    private val points = Array(49) { at(it / 48f) }
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
 * A chord to draw (the PC layout_table chords): its stroke runs from [trim].first to [trim].second of the length, and each
 * not-sent receiver end of a mixed pair is a polyline of points 4 dp apart, [endWidth] wide.
 */
private class ChordDraw(val curve: Curve, val width: Float, val ends: List<List<Offset>>, val trim: Pair<Float, Float>, val endWidth: Float) {
    /** The trimmed stroke: the whole curve, or a polyline when an end cuts it. */
    fun stroke(dp: Float): Path = if (ends.isEmpty()) curve.path else {
        val (low, high) = trim
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
    return ChordDraw(curve, width, ends, trim, max(3 * dp, width))
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
    colors: ActivityColors, onSeat: (String) -> Unit, onChord: (String) -> Unit, onClear: () -> Unit, onPeriod: (String) -> Unit,
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
    val notSent = remember(reply) { notSentCounts(reply.messages) }
    val marks = listOf("codex", "claude", "opencode", "").associateWith { painterResource(appMark(it)) }
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val palette = LocalPalette.current
    val machinesWithSeats = remember(reply) { activeSeats(reply).map { it.machineId }.distinct().size }
    val summary = "${plural(activeSeats(reply).size, "session")} on ${plural(machinesWithSeats, "machine")}, " +
        "${plural(ledger.total, "message")} in the last ${periodLabel(reply.period)}"
    // As on the PC narrow layout, the Messages section stands above the table; an empty period shows only the table.
    if (ledger.total > 0) MessagesSummary(ledger, colors)
    BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
        val sideDp = maxWidth
        val side = with(density) { sideDp.toPx() }
        val dp = density.density
        val geom = remember(side, seated, reply, colors, measurer) { layoutTable(side, dp, seated, reply.machines, colors, measurer) }
        // The neutral chord color for the background and the sector fills of the machines on the table.
        val gray = remember(geom, palette) {
            val fills = geom.ranges.keys.map { id ->
                mixColor(palette.background, hues.getValue(id).hex(), if (machineOffline(machines[id])) .03 else .05)
            }
            hexColor(chordGray(palette.background, palette.text, fills))
        }
        val curves = remember(geom, chordList) {
            val nMax = max(1, chordList.maxOfOrNull { it.n } ?: 1)
            chordList.associate { chord ->
                chord.key to geom.curve(chord.a, chord.b, seats[chord.a]?.machineId == seats[chord.b]?.machineId)?.let { chordDraw(chord, it, nMax, dp) }
            }
        }
        val currentOnSeat by rememberUpdatedState(onSeat)
        val currentOnChord by rememberUpdatedState(onChord)
        val currentOnClear by rememberUpdatedState(onClear)
        Canvas(
            Modifier.size(sideDp)
                .semantics { contentDescription = summary }
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
            drawTable(reply, geom, seated, chordList, curves, machines, hues, selectedSeat, selectedChord, flights,
                frameNanos, marks, colors, gray, measurer, dp, titles)
        }
        // TalkBack reaches each seat in circle order; a tap selects it, as a tap on its pin.
        for (seat in seated) {
            val pin = geom.pin(seat.id) ?: continue
            val count = counts[seat.id]
            val label = "${title(seat.id)}, ${appLabel(seat.app)}, ${machines[seat.machineId]?.name.orEmpty()}: " +
                "${count?.sent ?: 0} sent, ${count?.received ?: 0} received"
            Box(Modifier.offset { IntOffset((pin.x - 20 * dp).roundToInt(), (pin.y - 20 * dp).roundToInt()) }.size(40.dp)
                .clickable(interactionSource = null, indication = null, role = Role.Button) { onSeat(seat.id) }
                .clearAndSetSemantics { contentDescription = label; role = Role.Button })
        }
    }
    CenterPanel(reply, selectedSeat, selectedChord, counts, notSent, seats, machines, colors, title, onPeriod)
    val seatedIds = seated.map { it.id }.toSet()
    if (ledger.total > 0) LedgerView(ledger, busiest, reply, hues, machines, colors, title) { pair ->
        // A tap selects the chord of a pair whose two sessions are seated, as a tap on the chord.
        if (pair.a in seatedIds && pair.b in seatedIds) onChord(pair.key)
    }
}

private fun DrawScope.drawTable(
    reply: ActivityMessages, geom: TableGeom, seated: List<Seat>, chordList: List<Chord>, curves: Map<String, ChordDraw?>,
    machines: Map<String, ActivityMachine>, hues: Map<String, Color>, selected: String?,
    selectedChord: Chord?, flights: List<Flight>, frameNanos: Long, marks: Map<String, Painter>, colors: ActivityColors,
    gray: Color, measurer: TextMeasurer, dp: Float, titles: Map<String, String>,
) {
    if (geom.ranges.isEmpty()) return
    val c = geom.c
    val background = colors.background
    val dash = PathEffect.dashPathEffect(floatArrayOf(4 * dp, 3 * dp))
    val r0 = if (geom.small) 0f else geom.rc
    for ((id, range) in geom.ranges) {
        val offline = machineOffline(machines[id])
        val hue = hues[id] ?: continue
        drawPath(sectorPath(c, r0, geom.ri, range.first, range.second), hue.copy(alpha = if (offline) .03f else .05f))
        if (offline) for (a in listOf(range.first, range.second)) {
            drawLine(hue, geom.polar(r0, a), geom.polar(geom.ri, a), 1 * dp, pathEffect = dash)
        }
    }
    for ((id, range) in geom.ranges) {
        val offline = machineOffline(machines[id])
        val hue = hues[id] ?: continue
        val band = sectorPath(c, geom.ri, geom.ro, range.first, range.second)
        drawPath(band, hue.copy(alpha = if (offline) .45f else .85f))
        if (offline) drawPath(band, hue, style = Stroke(1 * dp, pathEffect = dash))
    }
    // Chords: at rest one neutral gray; a selection lights its chords in the accent, and the others mix 35% toward the background.
    val litChords = when {
        selectedChord != null -> setOf(selectedChord.key)
        selected != null -> chordList.filter { selected == it.a || selected == it.b }.map { it.key }.toSet()
        else -> emptySet()
    }
    // A selected seat lights its chords and their other ends.
    val litPins = when {
        selectedChord != null -> setOf(selectedChord.a, selectedChord.b)
        selected != null -> chordList.filter { it.key in litChords }.flatMap { listOf(it.a, it.b) }.toSet() + selected
        else -> emptySet()
    }
    val lighting = litChords.isNotEmpty() || litPins.isNotEmpty()
    val flying = if (lighting) emptySet() else flights.filter { it.startNanos <= frameNanos }.mapNotNull { pairKey(it.message, seated) }.toSet()
    val bad = statusColor("not-sent", colors)
    val dimGray = mixToward(background, gray, .35)
    val dimBad = mixToward(background, bad, .35)
    val badDash = PathEffect.dashPathEffect(floatArrayOf(5 * dp, 5 * dp))
    // Port of snapshot_chord: part is "casing", "stroke", or "ends" for the three passes of the lit chords, else "all".
    fun drawChord(chord: Chord, draw: ChordDraw, part: String) {
        val lit = chord.key in litChords
        val dim = !lit && (lighting || (flying.isNotEmpty() && chord.key !in flying))
        // A selection never recolors a not-sent mark: a lit all-not-sent chord stays dashed in the not-sent color, 3 dp wide.
        val color = when {
            chord.bad -> if (dim) dimBad else bad
            lit -> colors.accent
            else -> if (dim) dimGray else gray
        }
        val width = if (chord.bad && lit) 3 * dp else draw.width
        if (lit && part in setOf("all", "casing")) drawPath(draw.curve.path, background, style = Stroke(width + 2 * dp, cap = StrokeCap.Round))
        if (part in setOf("all", "stroke") && draw.trim.second > draw.trim.first) {
            drawPath(draw.stroke(dp), color, style = Stroke(width, cap = StrokeCap.Round, pathEffect = if (chord.bad) badDash else null))
        }
        // A mixed pair: each receiver end with not-sent messages is dashed in the not-sent color over a casing 2 dp wider.
        if (part in setOf("all", "casing")) for (end in draw.ends) drawPath(polyline(end), background, style = Stroke(draw.endWidth + 2 * dp))
        if (part in setOf("all", "ends")) for (end in draw.ends) {
            drawPath(polyline(end), if (dim) dimBad else bad, style = Stroke(draw.endWidth, pathEffect = badDash))
        }
    }
    for (chord in chordList) if (chord.key !in litChords) curves[chord.key]?.let { drawChord(chord, it, "all") }
    // The lit chords draw last, so that no chord crosses them: all casings, then all strokes, then all not-sent dashes.
    for (part in listOf("casing", "stroke", "ends")) {
        for (chord in chordList) if (chord.key in litChords) curves[chord.key]?.let { drawChord(chord, it, part) }
    }
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
    // Seat labels (the PC place_labels): nine places each, with the whole text, then cut to 10 and to 7 characters, else none.
    val machineBoxes = geom.labels.map { Rect(it.box.left - 1 * dp, it.box.top, it.box.right + 1 * dp, it.box.bottom) }
    val pinBoxes = seated.mapNotNull { geom.pin(it.id) }.map { Rect(it, 16 * dp) }
    val key = layoutKey(geom, chordList, machines, colors, measurer, dp, size, pinBoxes + geom.labels.map { it.box })
    val labelStyle = TextStyle(color = colors.text, fontSize = 12.sp)
    val texts = seated.associate { seat ->
        seat.id to seatLabelTexts(titles[seat.id] ?: UNLISTED).map { measurer.measure(it, labelStyle, maxLines = 1) }
    }
    // The selected seat and the two seats of the selected chord place first and show their whole label.
    val chosen = listOfNotNull(selected, selectedChord?.a, selectedChord?.b).distinct().filter { id -> seated.any { it.id == id } }
    val counts = seatCounts(reply.messages).mapValues { it.value.sent + it.value.received }
    val inputs = seated.filter { it.id in geom.angles }.map { seat ->
        SeatLabelInput(seat.id, geom.angles.getValue(seat.id), texts.getValue(seat.id).map { Size(it.size.width.toFloat(), it.size.height.toFloat()) })
    }
    // The pins and the not-sent end points are circles (the key line keeps the pin squares).
    val circles = seated.mapNotNull { geom.pin(it.id) }.map { pinCircle(it, dp) } +
        curves.values.filterNotNull().flatMap { draw -> draw.ends.flatten().map { endCircle(it, draw.endWidth, dp) } }
    val blocked = machineBoxes + listOfNotNull(key?.box?.takeIf { key.shown })
    val spots = placeSeatLabels(inputs, chosen, counts, activityTimes(reply.messages),
        LabelTable(c, geom.rp, geom.rc, !geom.small, size.width, size.height, blocked, geom.ri, geom.ro, circles), dp, litPins - chosen.toSet())
    for ((id, spot) in spots) {
        if (spot == null) continue
        // While the table dims, the labels of seats that are not lit draw in the muted color.
        drawHaloText(texts.getValue(id)[spot.text], Offset(spot.box.left + 1 * dp, spot.box.top), background, dp,
            if (lighting && id !in litPins) colors.muted else null)
    }
    // A chosen label without a free place can cover the key, which then hides.
    val keyShown = key != null && key.shown && spots.values.none { it != null && it.box.overlaps(key.box) }
    // Pins are opaque: the background fill, then the ring. A lit pin has a 2 dp accent ring; the others mix toward the background.
    for (seat in seated) {
        val pin = geom.pin(seat.id) ?: continue
        val offline = machineOffline(machines[seat.machineId])
        val hue = hues[seat.machineId] ?: colors.text
        val chosen = seat.id in litPins
        val factor = (if (offline) .75 else 1.0) * (if (lighting && !chosen) .35 else 1.0)
        drawCircle(background, 16 * dp, pin)
        if (chosen) drawCircle(colors.accent, 16 * dp, pin, style = Stroke(2 * dp))
        else drawCircle(mixToward(background, hue, factor), 16 * dp, pin, style = Stroke(1.5f * dp, pathEffect = if (offline) dash else null))
        val mark = marks[appKey(seat.app)] ?: continue
        translate(pin.x - 7 * dp, pin.y - 7 * dp) {
            with(mark) { draw(Size(14 * dp, 14 * dp), colorFilter = ColorFilter.tint(mixToward(background, colors.text, .85 * factor))) }
        }
    }
    for (label in geom.labels) drawText(label.layout, topLeft = Offset(label.x, label.y))
    key?.takeIf { keyShown }?.let { drawKey(it, colors, gray, dp) }
}

/** Port of snapshot_label: a 3 dp halo in the background color, from copies of the text around its place, then the text. */
private fun DrawScope.drawHaloText(layout: TextLayoutResult, topLeft: Offset, halo: Color, dp: Float, color: Color? = null) {
    for ((radius, steps) in listOf(1.5f to 8, 3f to 16)) {
        for (step in 0 until steps) {
            val angle = 2 * Math.PI * step / steps
            drawText(layout, color = halo, topLeft = topLeft + Offset(radius * dp * cos(angle).toFloat(), radius * dp * sin(angle).toFloat()))
        }
    }
    if (color != null) drawText(layout, color = color, topLeft = topLeft) else drawText(layout, topLeft = topLeft)
}

/** The key line: its items (kind, left x, text), its box, and whether it shows. */
private class KeyLayout(val items: List<Triple<String, Float, TextLayoutResult>>, val box: Rect, val middle: Float, val shown: Boolean)

/**
 * Port of layout_key: at the bottom left, a thin and a thick chord sample with the smallest and the largest pair counts, a dashed
 * Not sent sample, a Some not sent sample when a pair has both, and an Offline arc when a machine is offline. It shows only when
 * it touches none of [boxes] and stays outside the outer ring; null with no chords.
 */
private fun layoutKey(geom: TableGeom, chordList: List<Chord>, machines: Map<String, ActivityMachine>, colors: ActivityColors,
    measurer: TextMeasurer, dp: Float, size: Size, boxes: List<Rect>): KeyLayout? {
    if (chordList.isEmpty()) return null
    val low = chordList.minOf { it.n }
    val high = chordList.maxOf { it.n }
    val words = if (low != high) "${formatCount(low.toLong())} to ${formatCount(high.toLong())} messages" else plural(high, "message")
    val parts = listOf("chords" to "Line width: $words", "bad" to "Not sent") +
        (if (chordList.any { it.mixed }) listOf("mixed" to "Some not sent") else emptyList()) +
        if (geom.ranges.keys.any { machineOffline(machines[it]) }) listOf("offline" to "Offline") else emptyList()
    val style = TextStyle(color = colors.muted, fontSize = 11.sp)
    var x = 12 * dp
    val items = parts.map { (kind, text) ->
        val layout = measurer.measure(text, style, maxLines = 1)
        val sample = (if (kind == "chords") 32 else 18) * dp
        Triple(kind, x, layout).also { x += sample + 6 * dp + layout.size.width + 14 * dp }
    }
    val height = items.maxOf { it.third.size.height }.toFloat()
    val box = Rect(12 * dp, size.height - 12 * dp - height, x - 14 * dp, size.height - 12 * dp)
    val near = Offset(geom.c.x.coerceIn(box.left, box.right), geom.c.y.coerceIn(box.top, box.bottom))
    val clear = box.right <= size.width - 12 * dp && (near - geom.c).getDistance() > geom.ro + 2 * dp
    return KeyLayout(items, box, box.top + height / 2, clear && boxes.none { it.overlaps(box) })
}

/** Port of snapshot_key. */
private fun DrawScope.drawKey(key: KeyLayout, colors: ActivityColors, gray: Color, dp: Float) {
    val middle = key.middle
    val bad = statusColor("not-sent", colors)
    val dashes = PathEffect.dashPathEffect(floatArrayOf(5 * dp, 5 * dp))
    for ((kind, left, layout) in key.items) {
        when (kind) {
            "chords" -> for ((start, width) in listOf(left to 1.5f * dp, left + 18 * dp to 8.5f * dp)) {
                drawLine(gray, Offset(start + width / 2, middle), Offset(start + 14 * dp - width / 2, middle), width, StrokeCap.Round)
            }
            "bad" -> drawLine(bad, Offset(left + 1 * dp, middle), Offset(left + 17 * dp, middle), 2 * dp, pathEffect = dashes)
            // A gray chord, then a 3 dp dashed not-sent end over its casing in the background color, as on the table.
            "mixed" -> {
                drawLine(gray, Offset(left + 1 * dp, middle), Offset(left + 17 * dp, middle), 2 * dp)
                drawLine(colors.background, Offset(left + 9 * dp, middle), Offset(left + 17 * dp, middle), 5 * dp)
                drawLine(bad, Offset(left + 9 * dp, middle), Offset(left + 17 * dp, middle), 3 * dp, pathEffect = dashes)
            }
            else -> drawPath(Path().apply {
                moveTo(left + 1 * dp, middle + 4 * dp)
                quadraticTo(left + 9 * dp, middle - 7 * dp, left + 17 * dp, middle + 4 * dp)
            }, colors.muted, style = Stroke(1 * dp, pathEffect = PathEffect.dashPathEffect(floatArrayOf(4 * dp, 3 * dp))))
        }
        val sample = (if (kind == "chords") 32 else 18) * dp
        drawText(layout, topLeft = Offset(left + sample + 6 * dp, middle - layout.size.height / 2f))
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
    reply: ActivityMessages, seat: String?, chord: Chord?, counts: Map<String, SeatCount>, notSent: Map<String, Int>,
    seats: Map<String, Seat>, machines: Map<String, ActivityMachine>, colors: ActivityColors, title: (String) -> String,
    onPeriod: (String) -> Unit,
) {
    HorizontalDivider(thickness = 1.dp, color = colors.divider)
    Column(Modifier.fillMaxWidth().background(colors.background).padding(horizontal = 16.dp, vertical = 10.dp)
        .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        verticalArrangement = Arrangement.spacedBy(3.dp)) {
        val route = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = colors.text)
        val newest = newestMessage(reply.messages)
        when {
            chord != null -> {
                Text("${title(chord.a)} ⇄ ${title(chord.b)}", style = route, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text("→ ${formatCount(chord.ab.toLong())}", fontSize = 14.sp, style = figures, color = colors.text)
                Text("← ${formatCount(chord.ba.toLong())}", fontSize = 14.sp, style = figures, color = colors.text)
                NotSentLine(chord.badAb + chord.badBa, colors)
            }
            seat != null -> {
                val info = seats[seat]
                val count = counts[seat]
                Text(title(seat), fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = colors.text, maxLines = 1,
                    overflow = TextOverflow.Ellipsis)
                Text("${appLabel(info?.app.orEmpty())} · ${machines[info?.machineId]?.name.orEmpty()}", fontSize = 12.sp,
                    color = colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                    for ((label, value) in listOf("Sent" to (count?.sent ?: 0), "Received" to (count?.received ?: 0))) {
                        Column {
                            Text(label, fontSize = 11.sp, color = colors.muted)
                            Text(formatCount(value.toLong()), fontSize = 18.sp, style = figures, color = colors.text)
                        }
                    }
                }
                NotSentLine(notSent[seat] ?: 0, colors)
            }
            newest != null -> {
                Text("Newest message", fontSize = 11.sp, color = colors.muted)
                Text("${title(newest.from)} → ${title(newest.to)}", style = route, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(buildAnnotatedString {
                    append("${messageTime(newest.atMs, reply.nowMs.takeIf { it > 0 } ?: System.currentTimeMillis(), reply.period)} · ")
                    withStyle(SpanStyle(color = statusWordColor(newest.status, colors))) {
                        append(messageStatusLabel(newest))
                    }
                }, fontSize = 11.sp, style = figures, color = colors.muted)
            }
            // The block of the Usage empty page: the icon, the title, the hint, and the pill.
            else -> Column(Modifier.fillMaxWidth().padding(vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp),
                horizontalAlignment = Alignment.CenterHorizontally) {
                EmptyBlock(R.drawable.ic_messages, "No messages in the last ${periodLabel(reply.period)}",
                    "When an agent sends a message to another session, it shows here.", colors)
                NEXT_PERIOD[reply.period]?.let { next ->
                    AccentButton("Show the last ${periodLabel(next)}", colors, Modifier.padding(top = 4.dp)) { onPeriod(next) }
                }
            }
        }
    }
}

/** `Not sent N` (12 sp) in the not-sent status word color; nothing when [count] is 0. */
@Composable
private fun NotSentLine(count: Int, colors: ActivityColors) {
    if (count > 0) Text("Not sent ${formatCount(count.toLong())}", fontSize = 12.sp, style = figures, color = statusWordColor("not-sent", colors),
        modifier = Modifier.padding(top = 2.dp))
}

/** The empty page block: a muted 64 dp icon, the 20 sp bold title (at most 2 lines), and the hint (at most 260 dp wide). */
@Composable
internal fun EmptyBlock(icon: Int, title: String, hint: String, colors: ActivityColors) {
    Icon(painterResource(icon), contentDescription = null, tint = colors.muted, modifier = Modifier.size(64.dp))
    Text(title, fontSize = 20.sp, fontWeight = FontWeight.Bold, color = colors.text, textAlign = TextAlign.Center, maxLines = 2,
        overflow = TextOverflow.Ellipsis)
    Text(hint, fontSize = 12.sp, color = colors.muted, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 260.dp))
}

/** A filled pill button in the accent, with the background as its content color (the PC suggested-action pill). */
@Composable
internal fun AccentButton(text: String, colors: ActivityColors, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Button(onClick = onClick, modifier = modifier, shape = CircleShape,
        colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.background)) { Text(text) }
}

/** The Messages section: the total with the not-sent count, the status bar, and the legend. */
@Composable
private fun MessagesSummary(ledger: Ledger, colors: ActivityColors) {
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
        Row(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 10.dp).height(8.dp)
            .clearAndSetSemantics { contentDescription = shown.joinToString(", ") { "${statusLabel(it.first)} ${it.second}" } },
            horizontalArrangement = Arrangement.spacedBy(1.dp)) {
            for ((status, count) in shown) {
                Box(Modifier.weight(count.toFloat()).widthIn(min = 2.dp).height(8.dp)
                    .background(statusColor(status, colors), RoundedCornerShape(2.dp)))
            }
        }
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
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            for (pair in busiest) BusyPairRow(pair, title, colors) { onPair(pair) }
        }
        LedgerRule(colors)
        SectionTitle("Between machines", colors)
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            for (row in ledger.machineRows) {
                Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                        for (id in row.machineIds) MachineDot(hues[id] ?: colors.text, machineOffline(machines[id]))
                        // The empty place of a second dot: all names start at one x.
                        if (row.machineIds.size == 1) Spacer(Modifier.width(7.dp))
                    }
                    Text(if (row.machineIds.size > 1) row.label else "Within ${row.label}", fontSize = 12.sp, color = colors.text,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(formatCount(row.count.toLong()), fontSize = 12.sp, style = figures, color = colors.text)
                }
            }
        }
        LedgerRule(colors)
        SectionTitle("Between apps", colors)
        AppMatrix(ledger, colors)
    }
}

/** A Busiest pairs row: the route with each name ellipsized in the middle, the count, and a not-sent line when the pair has some. */
@Composable
private fun BusyPairRow(pair: BusyPair, title: (String) -> String, colors: ActivityColors, onClick: () -> Unit) {
    val a = title(pair.a)
    val b = title(pair.b)
    val spoken = "$a and $b, ${plural(pair.n, "message")}" + if (pair.bad > 0) ", ${formatCount(pair.bad.toLong())} not sent" else ""
    Row(Modifier.fillMaxWidth().heightIn(min = 26.dp).clickable(onClick = onClick).clearAndSetSemantics {
        contentDescription = spoken; role = Role.Button
    }, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                val name = Modifier.weight(1f, fill = false)
                Text(a, fontSize = 12.sp, color = colors.text, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = name)
                Text("⇄", fontSize = 12.sp, color = colors.text, maxLines = 1)
                Text(b, fontSize = 12.sp, color = colors.text, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = name)
            }
            if (pair.bad > 0) Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                val word = statusWordColor("not-sent", colors)
                StatusIcon("not-sent", word, 12.dp)
                Text("${formatCount(pair.bad.toLong())} not sent", fontSize = 12.sp, style = figures, color = word, maxLines = 1)
            }
        }
        Text(formatCount(pair.n.toLong()), fontSize = 12.sp, style = figures, color = colors.text)
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
    val cell = Modifier.height(24.dp).padding(horizontal = 4.dp)
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
