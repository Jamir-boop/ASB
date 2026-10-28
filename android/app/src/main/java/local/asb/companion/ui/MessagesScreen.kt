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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
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
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontFamily
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
import local.asb.companion.data.ActivityMachine
import local.asb.companion.data.ActivityMessage
import local.asb.companion.data.ActivityMessages
import local.asb.companion.data.Chord
import local.asb.companion.data.MESSAGE_PERIODS
import local.asb.companion.data.STATUS_COLORS
import local.asb.companion.data.Seat
import local.asb.companion.data.Ledger
import local.asb.companion.data.SeatCount
import local.asb.companion.data.activeSeats
import local.asb.companion.data.activityTimes
import local.asb.companion.data.appKey
import local.asb.companion.data.appLabel
import local.asb.companion.data.arrivals
import local.asb.companion.data.chords
import local.asb.companion.data.ledger
import local.asb.companion.data.machineHue
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
    val muted: Color, val accent: Color, val divider: Color)

@Composable
internal fun activityColors(): ActivityColors {
    val palette = LocalPalette.current
    return remember(palette) { activityColorsOf(palette) }
}

/** The status text colors: accepted text, written #959ba3, held and not-sent their swatch, unknown muted. */
internal fun statusTextColor(status: String, colors: ActivityColors): Color = when (statusKey(status)) {
    "accepted" -> colors.text
    "written" -> hexColor("#959ba3")
    "unknown" -> colors.muted
    else -> hexColor(STATUS_COLORS.getValue(statusKey(status)))
}

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
    descriptions: Map<String, String> = emptyMap(), onSelect: (String) -> Unit) {
    SingleChoiceSegmentedButtonRow(modifier.fillMaxWidth()) {
        choices.forEachIndexed { index, (value, label) ->
            SegmentedButton(
                selected = selected == value,
                onClick = { onSelect(value) },
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

internal val Mono = FontFamily.Monospace

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
private val BAD = Color(0xfff5a090)

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
                                MachineChip(machine, hexColor(machineHue(index)), colors)
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
                    current.messages.isEmpty() -> ActivityEmpty("No messages in ${periodLabel(period)}", colors)
                    else -> {
                        error?.let { Text(it, fontSize = 12.sp, color = colors.muted, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) }
                        MessagesContent(current, selected, chordKey, flights, frameNanos, colors,
                            onSeat = { onSelect(it); chordKey = null },
                            onChord = { chordKey = it; onSelect(null) },
                            onClear = { chordKey = null; onSelect(null) })
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

    val path: Path get() = Path().apply { moveTo(p0.x, p0.y); quadraticTo(q.x, q.y, p2.x, p2.y) }
}

private fun segmentDistance(p: Offset, a: Offset, b: Offset): Float {
    val ab = b - a
    val length = ab.x * ab.x + ab.y * ab.y
    val t = if (length > 0) (((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / length).coerceIn(0f, 1f) else 0f
    return (p - (a + ab * t)).getDistance()
}

/** The round table geometry of boards.html tableGeom, in pixels for a square of [side]. */
private class TableGeom(val side: Float, val dp: Float, seated: List<Seat>, machines: List<ActivityMachine>) {
    val c = Offset(side / 2, side / 2)
    val ro = side / 2 - 56 * dp
    val ri = ro - 10 * dp
    val rp = ri - 36 * dp
    val rc = min(120 * dp, ri * .4f)
    val small = side / dp < 480
    /** Start, end, and middle angle of each machine with seats, in machine order. */
    val ranges = LinkedHashMap<String, Triple<Float, Float, Float>>()
    val angles = HashMap<String, Float>()

    init {
        val withSeats = machines.filter { m -> seated.any { it.machineId == m.machineId } }
        val slot = if (seated.isEmpty()) 0f else (360f - 6 * withSeats.size) / seated.size
        var start = -90f - (withSeats.firstOrNull()?.let { m -> seated.count { it.machineId == m.machineId } } ?: 0) * slot / 2
        for (machine in withSeats) {
            val seats = seated.filter { it.machineId == machine.machineId }
            ranges[machine.machineId] = Triple(start, start + seats.size * slot, start + seats.size * slot / 2)
            seats.forEachIndexed { j, seat -> angles[seat.id] = start + (j + .5f) * slot }
            start += seats.size * slot + 6
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

/** A ring sector from [a0] to [a1] degrees; a full ring is two halves, as the preview draws it. */
internal fun sectorPath(c: Offset, r0: Float, r1: Float, a0: Float, a1: Float): Path = Path().apply {
    val parts = if (a1 - a0 >= 359.99f) listOf(a0 to a0 + 180, a0 + 180 to a0 + 360) else listOf(a0 to a1)
    for ((from, to) in parts) {
        arcTo(Rect(c, r1), from, to - from, true)
        if (r0 > 0) arcTo(Rect(c, r0), to, from - to, false) else lineTo(c.x, c.y)
        close()
    }
}

@Composable
private fun MessagesContent(
    reply: ActivityMessages, selected: String?, chordKey: String?, flights: List<Flight>, frameNanos: Long,
    colors: ActivityColors, onSeat: (String) -> Unit, onChord: (String) -> Unit, onClear: () -> Unit,
) {
    val seats = remember(reply) { reply.seats.associateBy { it.id } }
    val machines = remember(reply) { reply.machines.associateBy { it.machineId } }
    val hues = remember(reply) { reply.machines.mapIndexed { i, m -> m.machineId to hexColor(machineHue(i)) }.toMap() }
    val seated = remember(reply, selected) { seatedSeats(reply, selected) }
    val chordList = remember(reply, seated) { chords(reply.messages, seated) }
    val counts = remember(reply) { seatCounts(reply.messages) }
    val ledger = remember(reply) { ledger(reply) }
    val selectedChord = chordList.firstOrNull { it.key == chordKey }
    val title = { id: String -> seats[id]?.title?.ifEmpty { null } ?: "Other sessions" }
    val hue = { id: String -> hues[seats[id]?.machineId] ?: hexColor(machineHue(0)) }
    val marks = listOf("codex", "claude", "opencode", "").associateWith { painterResource(appMark(it)) }
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val machinesWithSeats = remember(reply) { activeSeats(reply).map { it.machineId }.distinct().size }
    val summary = "${plural(activeSeats(reply).size, "session")} on ${plural(machinesWithSeats, "machine")}, " +
        "${plural(ledger.total, "message")} in ${periodLabel(reply.period)}"
    BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
        val sideDp = maxWidth
        val side = with(density) { sideDp.toPx() }
        val dp = density.density
        val geom = remember(side, seated, reply) { TableGeom(side, dp, seated, reply.machines) }
        val curves = remember(geom, chordList) {
            chordList.associate { chord ->
                chord.key to geom.curve(chord.a, chord.b, seats[chord.a]?.machineId == seats[chord.b]?.machineId)
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
                        val chord = curves.entries.mapNotNull { (key, curve) -> curve?.let { key to it.distanceTo(point) } }
                            .minByOrNull { it.second }
                        when {
                            seat != null && seatDistance <= 20 * dp -> currentOnSeat(seat)
                            chord != null && chord.second <= 14 * dp -> currentOnChord(chord.first)
                            else -> currentOnClear()
                        }
                    }
                },
        ) {
            drawTable(reply, geom, seated, chordList, curves, machines, hues, seats, selected, selectedChord, flights,
                frameNanos, marks, colors, measurer, dp)
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
    CenterPanel(reply, selected?.takeIf { id -> seated.any { it.id == id } }, selectedChord, counts, seats, machines, colors, title)
    LedgerView(ledger, reply, hues, machines, colors, title)
}

private fun DrawScope.drawTable(
    reply: ActivityMessages, geom: TableGeom, seated: List<Seat>, chordList: List<Chord>, curves: Map<String, Curve?>,
    machines: Map<String, ActivityMachine>, hues: Map<String, Color>, seats: Map<String, Seat>, selected: String?,
    selectedChord: Chord?, flights: List<Flight>, frameNanos: Long, marks: Map<String, Painter>, colors: ActivityColors,
    measurer: TextMeasurer, dp: Float,
) {
    if (seated.isEmpty()) return
    val c = geom.c
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
        val machine = machines[id] ?: continue
        val label = geom.polar(geom.ro + 26 * dp, range.third)
        val cosA = cos(Math.toRadians(range.third.toDouble())).toFloat()
        val sinA = sin(Math.toRadians(range.third.toDouble())).toFloat()
        val dy = when { sinA < -.25f -> -8 * dp; sinA > .25f -> 8 * dp; else -> 0f }
        for ((text, style, y) in listOf(
            Triple(machine.name, TextStyle(color = colors.text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold), label.y + dy - 7 * dp),
            Triple(machineStateText(machine), TextStyle(color = colors.muted, fontSize = 11.sp), label.y + dy + 9 * dp),
        )) {
            val layout = measurer.measure(text, style, maxLines = 1)
            val x = when { cosA > .25f -> label.x; cosA < -.25f -> label.x - layout.size.width; else -> label.x - layout.size.width / 2f }
            drawText(layout, topLeft = Offset(x.coerceIn(0f, max(0f, size.width - layout.size.width)), y - layout.size.height / 2f))
        }
    }
    if (!geom.small) drawCircle(colors.background, geom.rc, c)
    if (!geom.small) drawCircle(colors.rule, geom.rc, c, style = Stroke(1 * dp))
    // Chords: a selection or a flight lights its chords and dims the others.
    val focus = selectedChord?.key
    val flying = flights.map { pairKey(it.message, seated) }.toSet()
    val nMax = max(1, chordList.maxOfOrNull { it.n } ?: 1)
    for (chord in chordList) {
        val curve = curves[chord.key] ?: continue
        val on = when {
            focus != null -> chord.key == focus
            selected != null -> selected == chord.a || selected == chord.b
            flying.isNotEmpty() -> chord.key in flying
            else -> null
        }
        val dim = if (focus != null || selected != null) .2f else .25f
        if (chord.bad) {
            drawPath(curve.path, BAD.copy(alpha = if (on == false) dim else .8f),
                style = Stroke(2 * dp, cap = StrokeCap.Round, pathEffect = PathEffect.dashPathEffect(floatArrayOf(5 * dp, 5 * dp))))
            continue
        }
        val ma = seats[chord.a]?.machineId
        val mb = seats[chord.b]?.machineId
        val alpha = when (on) { true -> 1f; false -> dim; null -> .55f }
        val width = (1.5f + 7 * sqrt(chord.n.toFloat() / nMax)) * dp
        val stroke = Stroke(width, cap = StrokeCap.Round)
        if (ma == mb) drawPath(curve.path, hues[ma] ?: colors.text, alpha = alpha, style = stroke)
        else {
            val aMore = chord.ab >= chord.ba
            val from = hues[if (aMore) ma else mb] ?: colors.text
            val to = hues[if (aMore) mb else ma] ?: colors.text
            drawPath(curve.path, Brush.linearGradient(listOf(from, to), if (aMore) curve.p0 else curve.p2,
                if (aMore) curve.p2 else curve.p0), alpha = alpha, style = stroke)
        }
    }
    // Lights: glow, a tail of 8 circles over the last 20% of the elapsed time, and the head.
    for (flight in flights) {
        val key = pairKey(flight.message, seated) ?: continue
        val curve = curves[key] ?: continue
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
    // Seat labels: all that fit on a large table; only the selected one on a small table.
    val placed = mutableListOf<Rect>()
    val pinBoxes = seated.mapNotNull { geom.pin(it.id) }.map { Rect(it, 16 * dp) }
    val times = activityTimes(reply.messages)
    val order = seated.sortedWith(compareBy<Seat> { if (it.id == selected) 0 else 1 }.thenByDescending { times[it.id] ?: 0L })
    for (seat in order) {
        if (geom.small && seat.id != selected) continue
        val degrees = geom.angles[seat.id] ?: continue
        val layout = measurer.measure(seat.title.ifEmpty { "Other sessions" }, TextStyle(color = colors.text, fontSize = 12.sp),
            maxLines = 1, overflow = TextOverflow.Ellipsis, constraints = Constraints(maxWidth = (160 * dp).toInt()))
        val hw = layout.size.width / 2f
        val rad = Math.toRadians(degrees.toDouble())
        val ux = abs(cos(rad)).toFloat()
        val uy = abs(sin(rad)).toFloat()
        val off = max(30 * dp, min(if (ux > .01f) (20 * dp + hw) / ux else Float.MAX_VALUE, if (uy > .01f) 27 * dp / uy else Float.MAX_VALUE))
        val center = geom.polar(geom.rp - off, degrees)
        val box = Rect(center.x - hw, center.y - layout.size.height / 2f, center.x + hw, center.y + layout.size.height / 2f)
        if (seat.id != selected && (placed.any { it.overlaps(box) } || pinBoxes.any { it.overlaps(box) })) continue
        placed += box
        drawRoundRect(colors.background.copy(alpha = .8f), box.topLeft - Offset(3 * dp, 0f), Size(box.width + 6 * dp, box.height),
            CornerRadius(3 * dp))
        drawText(layout, topLeft = box.topLeft)
    }
    // Pins: an offline machine's pins are dashed at .75; a selected seat dims the other pins.
    for (seat in seated) {
        val pin = geom.pin(seat.id) ?: continue
        val offline = machineOffline(machines[seat.machineId])
        val hue = hues[seat.machineId] ?: colors.text
        val alpha = (if (offline) .75f else 1f) * (if (selected != null && seat.id != selected) .4f else 1f)
        drawCircle(colors.background, 16 * dp, pin)
        drawCircle(hue, 16 * dp, pin, alpha = alpha,
            style = Stroke(1.5f * dp, pathEffect = if (offline) PathEffect.dashPathEffect(floatArrayOf(4 * dp, 3 * dp)) else null))
        val mark = marks[appKey(seat.app)] ?: continue
        translate(pin.x - 7 * dp, pin.y - 7 * dp) {
            with(mark) { draw(Size(14 * dp, 14 * dp), .85f * alpha, ColorFilter.tint(colors.text)) }
        }
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
    reply: ActivityMessages, seat: String?, chord: Chord?, counts: Map<String, SeatCount>,
    seats: Map<String, Seat>, machines: Map<String, ActivityMachine>, colors: ActivityColors, title: (String) -> String,
) {
    HorizontalDivider(thickness = 1.dp, color = colors.divider)
    Column(Modifier.fillMaxWidth().background(colors.background).padding(horizontal = 16.dp, vertical = 10.dp)
        .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        verticalArrangement = Arrangement.spacedBy(3.dp)) {
        val route = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = colors.text)
        when {
            chord != null -> {
                Text("${title(chord.a)} ⇄ ${title(chord.b)}", style = route, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text("→ ${formatCount(chord.ab.toLong())}", fontSize = 14.sp, fontFamily = Mono, color = colors.text)
                Text("← ${formatCount(chord.ba.toLong())}", fontSize = 14.sp, fontFamily = Mono, color = colors.text)
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
                            Text(formatCount(value.toLong()), fontSize = 18.sp, fontFamily = Mono, color = colors.text)
                        }
                    }
                }
            }
            else -> newestMessage(reply.messages)?.let { message ->
                Text(formatTime(message.atMs), fontSize = 12.sp, fontFamily = Mono, color = colors.muted)
                Text("${title(message.from)} → ${title(message.to)}", style = route, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                    val color = statusTextColor(message.status, colors)
                    StatusIcon(message.status, color, 14.dp)
                    Text(statusLabel(message.status), fontSize = 12.sp, color = color)
                }
            }
        }
    }
}

@Composable
private fun LedgerView(
    ledger: Ledger, reply: ActivityMessages, hues: Map<String, Color>,
    machines: Map<String, ActivityMachine>, colors: ActivityColors, title: (String) -> String,
) {
    HorizontalDivider(thickness = 1.dp, color = colors.divider)
    Column(Modifier.fillMaxWidth().background(colors.background).padding(horizontal = 18.dp, vertical = 16.dp)) {
        SectionTitle("Messages", colors)
        Text(formatCount(ledger.total.toLong()), fontSize = 30.sp, lineHeight = 42.sp, fontFamily = Mono,
            fontWeight = FontWeight.Bold, color = colors.text)
        val shown = ledger.byStatus.filter { it.second > 0 }
        Row(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 10.dp).height(8.dp)
            .clearAndSetSemantics { contentDescription = shown.joinToString(", ") { "${statusLabel(it.first)} ${it.second}" } },
            horizontalArrangement = Arrangement.spacedBy(1.dp)) {
            for ((status, count) in shown) {
                Box(Modifier.weight(count.toFloat()).widthIn(min = 2.dp).height(8.dp)
                    .background(hexColor(STATUS_COLORS.getValue(status)), RoundedCornerShape(2.dp)))
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            for ((status, count) in shown) {
                Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(8.dp).background(hexColor(STATUS_COLORS.getValue(status)), RoundedCornerShape(2.dp)))
                    Text(statusLabel(status), fontSize = 12.sp, color = colors.text, modifier = Modifier.weight(1f))
                    Text(formatCount(count.toLong()), fontSize = 12.sp, fontFamily = Mono, color = colors.text)
                }
            }
        }
        LedgerRule(colors)
        SectionTitle("Between apps", colors)
        AppMatrix(ledger, colors)
        Text(plural(ledger.appPairs, "app pair"), fontSize = 12.sp, color = colors.muted, modifier = Modifier.padding(top = 8.dp))
        LedgerRule(colors)
        SectionTitle("Between machines", colors)
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            for (row in ledger.machineRows) {
                Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                        for (id in row.machineIds) MachineDot(hues[id] ?: colors.text, machineOffline(machines[id]))
                    }
                    Text(row.label, fontSize = 12.sp, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f))
                    Text(formatCount(row.count.toLong()), fontSize = 12.sp, fontFamily = Mono, color = colors.text)
                }
            }
        }
        LedgerRule(colors)
        SectionTitle("Recent", colors)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            for (message in ledger.recent) {
                Row(Modifier.fillMaxWidth().height(24.dp).semantics(mergeDescendants = true) {},
                    horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(formatTime(message.atMs), fontSize = 12.sp, fontFamily = Mono, color = colors.muted, modifier = Modifier.width(44.dp))
                    Text("${title(message.from)} → ${title(message.to)}", fontSize = 12.sp, color = colors.text, maxLines = 1,
                        overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    StatusIcon(message.status, statusTextColor(message.status, colors), 14.dp, label = true)
                }
            }
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
    val cell = Modifier.height(24.dp).padding(horizontal = 4.dp)
    Column(Modifier.fillMaxWidth().semantics { contentDescription = "Messages from app (rows) to app (columns)" }) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("From \\ To", fontSize = 11.sp, color = colors.muted, maxLines = 1, modifier = Modifier.width(118.dp).then(cell))
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
                            Text(if (v == 0) "–" else formatCount(v.toLong()), fontSize = 12.sp, fontFamily = Mono,
                                color = if (v == 0) colors.muted else colors.text)
                        }
                    }
                }
            }
        }
    }
}
