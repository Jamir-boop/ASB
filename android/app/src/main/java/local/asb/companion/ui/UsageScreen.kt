package local.asb.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.ViewConfiguration
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.math.BigDecimal
import java.math.MathContext
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import local.asb.companion.R
import local.asb.companion.data.ActivityMachine
import local.asb.companion.data.ActivityUsage
import local.asb.companion.data.usageBucketRunning
import local.asb.companion.data.Metric
import local.asb.companion.data.RoundArc
import local.asb.companion.data.TypeShare
import local.asb.companion.data.USAGE_PERIODS
import local.asb.companion.data.UsageRow
import local.asb.companion.data.UsageTotals
import local.asb.companion.data.appLabel
import local.asb.companion.data.appRows
import local.asb.companion.data.chartBars
import local.asb.companion.data.chartSeries
import local.asb.companion.data.keptUsage
import local.asb.companion.data.costShares
import local.asb.companion.data.makerRows
import local.asb.companion.data.machineRows
import local.asb.companion.data.modelRows
import local.asb.companion.data.SessionsView
import local.asb.companion.data.USAGE_SESSION_ROWS
import local.asb.companion.data.usageChartAxis
import local.asb.companion.data.chartLabelShown
import local.asb.companion.data.usageCostBasis
import local.asb.companion.data.usageSessions
import local.asb.companion.data.usageRingNote
import local.asb.companion.data.periodLabel
import local.asb.companion.data.periodShortLabel
import local.asb.companion.data.roundArcs
import local.asb.companion.data.toggleMachine
import local.asb.companion.data.tokenShares
import local.asb.companion.data.unpricedNote
import local.asb.companion.data.usageFigures
import local.asb.companion.data.usageRefreshMs
import local.asb.companion.data.usageTotals
import local.asb.companion.net.AsbApi
import local.asb.companion.net.AsbError

private fun formatValue(value: Double, metric: Metric) =
    if (metric == Metric.COST) formatCost(value) else formatTokens(value.roundToLong())

private fun Double.roundToLong() = Math.round(this)

// The chart axis: 6 significant digits, at most 2 decimals, with K, M, or B for tokens.
private fun axisLabel(value: Double, metric: Metric): String {
    val format = DecimalFormat("#,##0.##", DecimalFormatSymbols(Locale.US))
    val plain = { v: Double -> format.format(BigDecimal(v).round(MathContext(6))) }
    if (metric == Metric.COST) return "$" + plain(value)
    return when {
        value >= 1e9 -> plain(value / 1e9) + "B"
        value >= 1e6 -> plain(value / 1e6) + "M"
        value >= 1e3 -> plain(value / 1e3) + "K"
        else -> plain(value)
    }
}

/** The app split of a Machines row for TalkBack, as the bar segments show it: `Codex $2,112.17, Claude Code $4,854.00`. */
internal fun appSplit(row: UsageRow, metric: Metric): String =
    row.segments.filter { it.second > 0 }.joinToString(", ") { (app, value) -> "${appLabel(app)} ${formatValue(value, metric)}" }

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun UsageScreen(api: AsbApi, engine: String, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val colors = activityColors()
    var period by rememberSaveable { mutableStateOf("all") }
    var metric by rememberSaveable { mutableStateOf(Metric.COST) }
    var byMachine by rememberSaveable { mutableStateOf(false) }
    var off by rememberSaveable { mutableStateOf(listOf<String>()) }
    var reply by remember(engine, period) { mutableStateOf<ActivityUsage?>(null) }
    var error by remember(engine, period) { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    PollWhileResumed(api, engine, period, attempt, intervalMs = { usageRefreshMs(reply) }) {
        try {
            reply = keptUsage(reply, api.activityUsage(period, engine))
            error = null
        } catch (cause: AsbError) {
            error = cause.message
        }
    }
    Scaffold(contentWindowInsets = SafeContentInsets, topBar = {
        ActivityTopBar("Usage", onBack, subtitle = reply?.let { pricesText(it.prices) }.orEmpty())
    }) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding), contentAlignment = Alignment.TopCenter) {
            Column(Modifier.widthIn(max = 840.dp).fillMaxWidth().verticalScroll(rememberScrollState())) {
                val current = reply
                val machineIds = current?.machines?.map { it.machineId }.orEmpty()
                val offSet = off.toSet().intersect(machineIds.toSet())
                // The error page and the empty page disable the metric choice and the machine chips.
                val statePage = (current == null && error != null) || current?.records?.isEmpty() == true
                Column(Modifier.fillMaxWidth().background(colors.background).padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    ChoiceRow(USAGE_PERIODS.map { it to periodShortLabel(it) }, period,
                        descriptions = USAGE_PERIODS.associateWith { periodLabel(it) }) { period = it }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        ChoiceRow(listOf(Metric.COST.name to "Cost", Metric.TOKENS.name to "Tokens"), metric.name,
                            Modifier.width(168.dp), enabled = !statePage) { metric = Metric.valueOf(it) }
                        if (current != null) {
                            val onCount = machineIds.count { it !in offSet }
                            // The chips wrap to more lines, so no chip is cut at the screen edge.
                            FlowRow(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                current.machines.forEachIndexed { index, machine ->
                                    val on = machine.machineId !in offSet
                                    Box(Modifier.heightIn(min = 48.dp).toggleable(value = on, enabled = !statePage && !(on && onCount == 1),
                                        role = Role.Switch) { off = toggleMachine(machineIds, offSet, machine.machineId).toList() },
                                        contentAlignment = Alignment.Center) {
                                        MachineChip(machine, colors.hue(index), colors, Modifier.alpha(if (on && !statePage) 1f else .5f),
                                            strike = !on)
                                    }
                                }
                            }
                        }
                    }
                    if (current != null) {
                        scanText(current.scan).takeIf { it.isNotEmpty() }?.let { Text(it, fontSize = 12.sp, color = colors.muted) }
                    }
                }
                HorizontalDivider(thickness = 1.dp, color = colors.divider)
                when {
                    current == null && error != null -> ActivityError(error.orEmpty(), "usage", colors) { attempt++ }
                    current == null -> ActivityLoading()
                    current.records.isEmpty() -> UsageEmpty(period, colors) { period = "all" }
                    else -> {
                        error?.let { Text(it, fontSize = 12.sp, color = colors.muted, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) }
                        val totals = remember(current, offSet) { usageTotals(current, offSet) }
                        UsageContent(current, totals, metric, byMachine, { byMachine = it }, colors)
                    }
                }
            }
        }
    }
}

/** The title and the action of the Usage empty state, as the PC: All time has no action. */
internal fun usageEmptyWords(period: String): Pair<String, String?> =
    if (period == "all") "No usage yet" to null else "No usage in the last ${periodLabel(period)}" to "Show all time"

@Composable
private fun UsageEmpty(period: String, colors: ActivityColors, onAllTime: () -> Unit) {
    val (title, action) = usageEmptyWords(period)
    StatePanel(title, USAGE_EMPTY_HINT, colors, action, onAllTime)
}

@Composable
private fun UsageContent(reply: ActivityUsage, totals: UsageTotals, metric: Metric, byMachine: Boolean,
    onSplit: (Boolean) -> Unit, colors: ActivityColors) {
    val hues = remember(reply, colors) { reply.machines.mapIndexed { i, m -> m.machineId to colors.hue(i) }.toMap() }
    val machines = remember(reply) { reply.machines.associateBy { it.machineId } }
    Column(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 16.dp, bottom = 32.dp)) {
        RoundChart(reply, totals, metric, colors)
        Spacer(Modifier.height(16.dp))
        SectionTitle("Machines", colors)
        for (row in machineRows(totals, metric, reply)) {
            val machine = machines[row.key]
            UsageRowView(row, metric, colors, sub = machine?.let(::machineStateLine),
                spoken = listOf(machine?.name.orEmpty(), machine?.let(::machineStateLine).orEmpty(), rowWord(row) ?: formatValue(row.value, metric),
                    if (rowWord(row) == null) formatShare(row.share) else "", appSplit(row, metric)).filter { it.isNotEmpty() }.joinToString(", "), bar = {
                val segments = row.segments.filter { it.second > 0 }
                Row(Modifier.fillMaxWidth(row.share.toFloat().coerceIn(0f, 1f)).height(10.dp), horizontalArrangement = Arrangement.spacedBy(1.dp)) {
                    for ((app, value) in segments) Box(Modifier.weight(value.toFloat()).height(10.dp)
                        .background(appColor(app, colors), RoundedCornerShape(2.dp)))
                }
            }) {
                MachineDot(hues[row.key] ?: colors.text, machineOffline(machine))
                Text(machine?.name.orEmpty(), fontSize = 13.sp, color = colors.text,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Spacer(Modifier.height(20.dp))
        SectionTitle("Apps", colors)
        for (row in appRows(totals, metric)) {
            UsageRowView(row, metric, colors, sub = null, bar = {
                Box(Modifier.fillMaxWidth(row.share.toFloat().coerceIn(0f, 1f)).height(10.dp)
                    .background(appColor(row.key, colors), RoundedCornerShape(2.dp)))
            }) {
                Icon(painterResource(appMark(row.key)), contentDescription = null, tint = colors.text, modifier = Modifier.size(14.dp))
                Text(appLabel(row.key), fontSize = 13.sp, color = colors.text,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Spacer(Modifier.height(20.dp))
        SectionTitle("Providers", colors)
        for (row in makerRows(totals, metric)) {
            UsageRowView(row, metric, colors, sub = null, bar = {
                Box(Modifier.fillMaxWidth(row.share.toFloat().coerceIn(0f, 1f)).height(10.dp)
                    .background(colors.accent, RoundedCornerShape(2.dp)))
            }) {
                Text(row.key, fontSize = 13.sp, color = colors.text,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (metric == Metric.COST) unpricedNote(totals, ::formatTokens)?.let {
            Text(it, fontSize = 12.sp, color = colors.muted, modifier = Modifier.padding(top = 10.dp))
        }
        Spacer(Modifier.height(28.dp))
        UsageChart(reply, totals, metric, byMachine, onSplit, hues, colors)
        Spacer(Modifier.height(28.dp))
        SectionTitle(usageTotalsTitle(!reply.scan.complete), colors)
        Spacer(Modifier.height(6.dp))
        usageFigures(totals).chunked(2).forEach { pair ->
            Row(Modifier.fillMaxWidth().padding(bottom = 16.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                for (figure in pair) Column(Modifier.weight(1f).semantics(mergeDescendants = true) {}) {
                    Text(figure.label, fontSize = 12.sp, color = colors.muted)
                    Text(figure.tokens?.let(::formatTokens) ?: formatCost(figure.cost ?: 0.0), fontSize = 20.sp, style = figures,
                        color = colors.text)
                    if (figure.label == "Cache savings") Text(CACHE_SAVINGS_NOTE, fontSize = 11.sp, color = colors.muted)
                    // The cost basis, as in the ring center; it breaks only between its parts.
                    if (figure.label == "Cost") Text(usageCostBasis(totals), fontSize = 11.sp, color = colors.muted)
                }
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
        TypeBlock("Tokens by type", tokenShares(totals), { formatTokens(it.roundToLong()) }, colors)
        Spacer(Modifier.height(20.dp))
        TypeBlock("Cost by type", costShares(totals), ::formatCost, colors)
        Spacer(Modifier.height(28.dp))
        SectionTitle("Models", colors)
        ModelsTable(totals, metric, colors)
        // The rows that the rest row button added stay over a live refresh, not over a new period, metric, or machine filter.
        var extra by remember(sessionScope(reply.period, metric, totals.machineIds)) { mutableIntStateOf(0) }
        usageSessions(reply, totals, metric, USAGE_SESSION_ROWS + extra)?.let { sessions ->
            Spacer(Modifier.height(28.dp))
            SectionTitle("Sessions", colors)
            SessionsTable(sessions, machines, hues, metric, colors) { extra += USAGE_SESSION_ROWS }
        }
    }
}

@Composable
private fun UsageRowView(row: UsageRow, metric: Metric, colors: ActivityColors, sub: String?, bar: @Composable () -> Unit,
    spoken: String? = null, name: @Composable () -> Unit) {
    Column {
        // A Machines row adds its app split to what TalkBack reads.
        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(vertical = 6.dp)
            .then(if (spoken != null) Modifier.clearAndSetSemantics { contentDescription = spoken } else Modifier.semantics(mergeDescendants = true) {}),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.width(112.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) { name() }
                sub?.let { FactsText(it, TextStyle(fontSize = 11.sp, color = colors.muted)) }
            }
            // The track starts 1 dp after the filled part, so a background-colored gap separates them.
            val fraction = row.share.toFloat().coerceIn(0f, 1f)
            Box(Modifier.weight(1f).height(10.dp).drawBehind {
                val start = trackStart(size.width, fraction, 1.dp.toPx())
                if (start < size.width) drawRoundRect(colors.track, Offset(start, 0f), Size(size.width - start, size.height),
                    CornerRadius(2.dp.toPx()))
            }) { bar() }
            val word = rowWord(row)
            Text(word ?: formatValue(row.value, metric), fontSize = 13.sp, style = figures,
                color = if (word != null) colors.muted else colors.text, textAlign = TextAlign.End,
                maxLines = 1, modifier = Modifier.width(84.dp))
            Text(if (word != null) "" else formatShare(row.share), fontSize = 12.sp, color = colors.muted, textAlign = TextAlign.End, maxLines = 1,
                modifier = Modifier.width(44.dp))
        }
        HorizontalDivider(thickness = 1.dp, color = colors.rule)
    }
}

/** Port of the UsageBar track start: [gap] after the filled part; a full bar has no track, an empty bar is all track. */
internal fun trackStart(width: Float, fraction: Float, gap: Float): Float = min(width, width * fraction + if (fraction > 0) gap else 0f)

/** The share of a ring arc, as its tooltip: an app arc of its machine (`27.4% of Desk`), a machine arc of the total. */
internal fun arcShare(arc: RoundArc, names: Map<String, String>): String =
    "${formatShare(arc.share)} of ${if (arc.app != null) names[arc.machineId].orEmpty() else "total"}"

/** A machine state that breaks only between its facts ([factLines]) and never ellipsizes. */
@Composable
private fun FactsText(line: String, style: TextStyle) {
    val measurer = rememberTextMeasurer()
    BoxWithConstraints {
        val width = constraints.maxWidth.toFloat()
        val text = remember(line, width, style) {
            factLines(line, width) { measurer.measure(it, style, maxLines = 1, softWrap = false).size.width.toFloat() }.joinToString("\n")
        }
        Text(text, style = style)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RoundChart(reply: ActivityUsage, totals: UsageTotals, metric: Metric, colors: ActivityColors) {
    val arcs = remember(reply, totals, metric) { roundArcs(reply, totals, metric) }
    var tapped by remember(arcs) { mutableStateOf<RoundArc?>(null) }
    val names = remember(reply) { reply.machines.associate { it.machineId to it.name } }
    val arcLabel = { arc: RoundArc -> arc.app?.let { "${appLabel(it)} on ${names[arc.machineId].orEmpty()}" } ?: names[arc.machineId].orEmpty() }
    val total = if (metric == Metric.COST) totals.cost else totals.tokens.toDouble()
    val value = tapped?.let { formatValue(it.value, metric) } ?: formatValue(total, metric)
    val sub = tapped?.let(arcLabel) ?: if (metric == Metric.COST) "if paid at API prices" else "processed tokens"
    // The third center line: the share of the tapped arc, else the ring note.
    val note = tapped?.let { arcShare(it, names) } ?: usageRingNote(!reply.scan.complete, totals.machineIds.size, reply.machines.size,
        metric == Metric.COST, totals.unpricedTokens, totals.unpricedModels.size)
    val hues = remember(reply, colors) { reply.machines.mapIndexed { i, m -> m.machineId to colors.hue(i) }.toMap() }
    val arcColor = { arc: RoundArc -> arc.app?.let { appColor(it, colors) } ?: hues[arc.machineId] ?: colors.hue(0) }
    val measurer = rememberTextMeasurer()
    val summary = (listOf(listOf(value, sub, note).filter { it.isNotEmpty() }.joinToString(" ")) +
        arcs.map { "${arcLabel(it)}: ${formatValue(it.value, metric)}" }).joinToString(", ")
    BoxWithConstraints(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        val side = min(320f, maxWidth.value).dp
        Canvas(Modifier.size(side).semantics { contentDescription = summary }.pointerInput(arcs) {
            detectTapGestures { point ->
                val k = size.width / 320f
                val c = Offset(size.width / 2f, size.height / 2f)
                val d = (point - c).getDistance() / k
                var angle = Math.toDegrees(atan2((point.y - c.y).toDouble(), (point.x - c.x).toDouble()))
                if (angle < -90) angle += 360
                val hit = arcs.firstOrNull { d >= it.r0 && d <= it.r1 && angle >= it.a0 && angle <= it.a1 }
                tapped = if (hit == tapped) null else hit
            }
        }) {
            val k = size.width / 320f
            val c = Offset(size.width / 2f, size.height / 2f)
            for (arc in arcs) {
                val mid = Math.toRadians((arc.a0 + arc.a1) / 2)
                val shift = if (arc == tapped) Offset((4 * cos(mid)).toFloat(), (4 * sin(mid)).toFloat()) * k else Offset.Zero
                val path = sectorPath(c + shift, arc.r0 * k, arc.r1 * k, arc.a0.toFloat(), arc.a1.toFloat())
                if (arc == tapped) {
                    // Strokes centered on the outline: a 2 dp accent ring outside a 1 dp background gap, then the fill.
                    drawPath(path, colors.accent, style = Stroke(6 * density))
                    drawPath(path, colors.background, style = Stroke(2 * density))
                }
                drawPath(path, arcColor(arc))
            }
            val big = measurer.measure(value, TextStyle(color = colors.text, fontSize = 26.sp, fontFeatureSettings = "tnum", fontWeight = FontWeight.Bold),
                maxLines = 1)
            val room = androidx.compose.ui.unit.Constraints(maxWidth = (170 * k * density).toInt().coerceAtLeast(1))
            val small = measurer.measure(sub, TextStyle(color = colors.muted, fontSize = 12.sp), maxLines = 1,
                overflow = TextOverflow.Ellipsis, constraints = room)
            val extra = note.takeIf { it.isNotEmpty() }?.let {
                measurer.measure(it, TextStyle(color = colors.muted, fontSize = 11.sp, textAlign = TextAlign.Center), maxLines = 2,
                    overflow = TextOverflow.Ellipsis, constraints = room)
            }
            // A note moves the value and its label up by half of its height and 4 dp; it starts 4 dp under the label.
            val lift = extra?.let { (it.size.height + 4 * density) / 2 } ?: 0f
            drawText(big, topLeft = Offset(c.x - big.size.width / 2f, c.y - 6 * k * density - lift - big.size.height / 2f))
            val labelTop = c.y + 18 * k * density - lift - small.size.height / 2f
            drawText(small, topLeft = Offset(c.x - small.size.width / 2f, labelTop))
            extra?.let { drawText(it, topLeft = Offset(c.x - it.size.width / 2f, labelTop + small.size.height + 4 * density)) }
        }
    }
    // One key per app of the outer ring, in ring order.
    val keys = arcs.mapNotNull { it.app }.distinct()
    if (keys.isNotEmpty()) {
        FlowRow(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally),
            verticalArrangement = Arrangement.spacedBy(4.dp)) {
            for (app in keys) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(8.dp).background(appColor(app, colors), CircleShape))
                    Text(appLabel(app), fontSize = 12.sp, color = colors.text, maxLines = 1)
                }
            }
        }
    }
}

@Composable
private fun UsageChart(reply: ActivityUsage, totals: UsageTotals, metric: Metric, byMachine: Boolean, onSplit: (Boolean) -> Unit,
    hues: Map<String, Color>, colors: ActivityColors) {
    val unit = reply.buckets.unit
    val starts = reply.buckets.startsMs
    val series = chartSeries(totals, byMachine)
    val bars = remember(totals, byMachine, metric) { chartBars(totals, byMachine, metric) }
    val names = remember(reply) { reply.machines.associate { it.machineId to it.name } }
    val seriesColor = { id: String -> if (byMachine) hues[id] ?: colors.text else appColor(id, colors) }
    val seriesLabel = { id: String -> if (byMachine) names[id].orEmpty() else appLabel(id) }
    var tapped by remember(bars) { mutableStateOf<Int?>(null) }
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val first = partialFirstLabel(unit, starts, reply.buckets.firstMs)
    Text(usageChartTitle(unit, metric == Metric.COST, !reply.scan.complete), fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold, color = colors.text)
    Spacer(Modifier.height(6.dp))
    ChoiceRow(listOf("app" to "By app", "machine" to "By machine"), if (byMachine) "machine" else "app") { onSplit(it == "machine") }
    Spacer(Modifier.height(12.dp))
    val sums = bars.map { it.sum() }
    // 8 % headroom over the tallest bar, on the round steps of the PC axis.
    val (step, lines) = usageChartAxis(sums.maxOrNull() ?: 0.0)
    // The top of the plot is the top line.
    val yMax = step * lines
    val n = bars.size
    val dp = density.density
    val axis = TextStyle(color = colors.muted, fontSize = 11.sp)
    // The y labels set the left room and the top inset, and the x labels the room under the plot, so no label is cut at any text size.
    val yLabels = (1..lines).map { measurer.measure(axisLabel(step * it, metric), axis, maxLines = 1) }
    val left = maxOf(48 * dp, (yLabels.maxOfOrNull { it.size.width } ?: 0) + 12 * dp)
    val plotT = maxOf(8 * dp, (yLabels.maxOfOrNull { it.size.height } ?: 0) / 2f + 1 * dp)
    val plotB = plotT + 212 * dp
    val xHeight = measurer.measure("00:00", axis, maxLines = 1).size.height
    val chartHeight = plotB + 6 * dp + xHeight + 2 * dp
    val gap = (if (n >= 90) 1 else 2) * dp
    // Only a last bucket that is still running is lighter and says so far.
    val running = usageBucketRunning(reply)
    val tipTitle = { i: Int -> tooltipTitle(starts.getOrElse(i) { 0L }, unit, running && i == n - 1, first.takeIf { i == 0 }, reply.nowMs) }
    var width by remember { mutableIntStateOf(0) }
    val geom = BarGeom(left, width.toFloat(), n, gap)
    Box(Modifier.fillMaxWidth().height(with(density) { chartHeight.toDp() }).onSizeChanged { width = it.width }) {
        Canvas(Modifier.fillMaxSize().semantics { contentDescription = chartSummary(reply.period, unit, starts, sums, metric) }
            // Keyed on bars as tapped is: a handler from older bars would set a state that nothing reads.
            .pointerInput(bars, left, gap) {
                detectTapGestures { point ->
                    val i = BarGeom(left, size.width.toFloat(), n, gap).indexAt(point.x)
                    tapped = if (i != tapped) i else null
                }
            }
            // A horizontal drag after the touch slop moves the selection to the column under the finger; a vertical drag is left
            // to the page scroll.
            .pointerInput(bars, left, gap) {
                val pick = { x: Float -> tapped = scrubIndex(BarGeom(left, size.width.toFloat(), n, gap), x, tapped) }
                detectHorizontalDragGestures(onDragStart = { pick(it.x) }) { change, _ -> pick(change.position.x) }
            }) {
            if (n == 0) return@Canvas
            val y = { v: Double -> plotB - (plotB - plotT) * (v / yMax).toFloat() }
            for (k in 1..lines) {
                val gy = y(step * k)
                drawLine(colors.rule, Offset(left, gy), Offset(size.width, gy), 1 * dp, pathEffect = PathEffect.dashPathEffect(floatArrayOf(3 * dp, 3 * dp)))
                val layout = yLabels[k - 1]
                drawText(layout, topLeft = Offset(left - 8 * dp - layout.size.width, gy - layout.size.height / 2f))
            }
            val g = BarGeom(left, size.width, n, gap)
            val bw = g.bar
            bars.forEachIndexed { i, values ->
                val x = g.barLeft(i)
                // The current bucket is still running: a lighter fill, so that it does not read as a drop.
                val fill = barAlpha(i, n, running)
                var acc = 0.0
                val visible = values.indices.filter { values[it] > 0 }
                for (s in visible) {
                    val y0 = y(acc)
                    acc += values[s]
                    val y1 = y(acc)
                    val r = if (s == visible.last()) min(2 * dp, min(bw / 2, y0 - y1)) else 0f
                    drawPath(Path().apply {
                        moveTo(x, y0); lineTo(x, y1 + r); quadraticTo(x, y1, x + r, y1); lineTo(x + bw - r, y1)
                        quadraticTo(x + bw, y1, x + bw, y1 + r); lineTo(x + bw, y0); close()
                    }, seriesColor(series[s]).copy(alpha = fill))
                }
                if (i == tapped && sums[i] > 0) {
                    val top = y(sums[i])
                    drawRect(colors.text, Offset(x - .5f * dp, top - .5f * dp), Size(bw + dp, plotB - top + dp), style = Stroke(1 * dp))
                }
            }
            val centers = List(n) { g.center(it) }
            val measure = { text: String -> measurer.measure(text, axis, maxLines = 1).size.width.toFloat() }
            val even = unit == "hour" || unit == "day"
            val labels = if (even) evenAxisLabels(starts, unit, centers, size.width, 4 * dp, measure)
                else axisLabels(starts, unit, centers, size.width, 4 * dp, measure, first, endGap = 16 * dp)
            for (label in labels) {
                val layout = measurer.measure(label.text, axis, maxLines = 1)
                val w = layout.size.width.toFloat()
                // On a week or month chart the last label ends at the right edge of the chart.
                val cx = if (label.index == n - 1 && !even) size.width - w / 2 else centers[label.index].coerceIn(w / 2, size.width - w / 2)
                drawText(layout, topLeft = Offset(cx - w / 2, plotB + 6 * dp))
            }
        }
        // TalkBack reaches each bar with its time and values, as the PC tooltip reads; a double tap shows its tooltip. Each node is
        // the full column of its bar (the plot height), at the same x as the drawn bar and the tap. No 48 dp minimum touch target:
        // it would widen each node, and each next node would cover the right part of the one before, one bar to the left.
        if (n > 0 && width > 0) CompositionLocalProvider(LocalViewConfiguration provides exactTouchBounds(LocalViewConfiguration.current)) {
            for (i in 0 until n) {
                val (x0, x1) = geom.column(i)
                val rows = tipOrder(bars[i]).map { seriesLabel(series[it]) to formatValue(bars[i][it], metric) }
                Box(Modifier.offset { IntOffset(x0.roundToInt(), plotT.roundToInt()) }
                    .size(with(density) { (x1 - x0).toDp() }, with(density) { (plotB - plotT).toDp() })
                    .semantics {
                        contentDescription = barDescription(tipTitle(i), formatValue(sums[i], metric), rows)
                        onClick { tapped = if (tapped == i) null else i; true }
                    })
            }
        }
        tapped?.takeIf { width > 0 }?.let { i ->
            var tipSize by remember { mutableStateOf(IntSize.Zero) }
            val barTop = plotB - (plotB - plotT) * (sums[i] / yMax).toFloat()
            val place = tipPlace(geom.barLeft(i), geom.barLeft(i) + geom.bar, barTop, width.toFloat(), chartHeight,
                tipSize.width.toFloat(), tipSize.height.toFloat(), 8 * dp)
            // The PC box: the title, Total, a rule, and the series. Its width is the widest row, so no text is cut.
            Column(Modifier.offset { IntOffset(place.x.roundToInt(), place.y.roundToInt()) }.onSizeChanged { tipSize = it }
                .width(IntrinsicSize.Max).widthIn(min = 150.dp).background(colors.background, RoundedCornerShape(4.dp))
                .border(1.dp, colors.edge, RoundedCornerShape(4.dp)).padding(horizontal = 10.dp, vertical = 8.dp).clearAndSetSemantics {}) {
                Text(tipTitle(i), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = colors.text, modifier = Modifier.padding(bottom = 4.dp))
                TipRow("Total", formatValue(sums[i], metric), colors.accent, colors)
                HorizontalDivider(Modifier.padding(vertical = 4.dp), thickness = 1.dp, color = colors.rule)
                // The series high to low by their value in this bucket; a stable sort keeps the series order for ties.
                for (s in tipOrder(bars[i])) TipRow(seriesLabel(series[s]), formatValue(bars[i][s], metric), seriesColor(series[s]), colors)
            }
        }
    }
}

/**
 * The top left of the bar tooltip ([w] by [h]) in the chart ([width] by [height]); it never covers its bar, from [left] to [right]
 * with its top at [top]. Above the bar when it fits there; else beside the bar on the side with more room (as the PC tip_box);
 * else above the chart.
 */
internal fun tipPlace(left: Float, right: Float, top: Float, width: Float, height: Float, w: Float, h: Float, gap: Float): Offset {
    val centered = ((left + right) / 2 - w / 2).coerceIn(0f, maxOf(0f, width - w))
    if (top - gap - h >= 0) return Offset(centered, top - gap - h)
    val y = (top - h / 2).coerceIn(0f, maxOf(0f, height - h))
    val rightRoom = width - right - gap
    val leftRoom = left - gap
    return when {
        rightRoom >= w && (rightRoom >= leftRoom || leftRoom < w) -> Offset(right + gap, y)
        leftRoom >= w -> Offset(left - gap - w, y)
        else -> Offset(centered, -gap - h)
    }
}

/** [base] with no minimum touch target, so a node keeps its own bounds for TalkBack. */
internal fun exactTouchBounds(base: ViewConfiguration): ViewConfiguration = object : ViewConfiguration by base {
    override val minimumTouchTargetSize = DpSize.Zero
}

/** The fill alpha of the current (running) bucket of the Usage chart. */
internal const val SO_FAR_ALPHA = .45f

/** The fill alpha of bar [i] of [n]: [SO_FAR_ALPHA] only for the last bar while its bucket is [running], else 1. */
internal fun barAlpha(i: Int, n: Int, running: Boolean): Float = if (running && i == n - 1) SO_FAR_ALPHA else 1f

/**
 * The bar geometry of the Usage chart: [n] bars from [left] to [width], [gap] apart. The drawing, the tap, and the TalkBack
 * nodes all use it, so a bar, its tap, and its node have one index.
 */
internal class BarGeom(val left: Float, val width: Float, val n: Int, val gap: Float) {
    /** A bar and the gap after it. */
    val slot = if (n > 0) (width - left + gap) / n else 0f
    val bar = slot - gap
    fun barLeft(i: Int) = left + i * slot
    fun center(i: Int) = barLeft(i) + bar / 2
    /** The column of bar [i]: its slot centered on the bar, so the columns tile the plot and touch at the gap middles. */
    fun column(i: Int): Pair<Float, Float> = center(i) - slot / 2 to center(i) + slot / 2
    /** The bar whose center is nearest to [x], or null outside the plot. */
    fun indexAt(x: Float): Int? = if (n <= 0 || x < left - gap / 2 || x > width) null
        else ((x - left + gap / 2) / slot).toInt().coerceIn(0, n - 1)
}

/** The bar a scrub at [x] selects: the column under the finger, or [current] outside the plot. */
internal fun scrubIndex(geom: BarGeom, x: Float, current: Int?): Int? = geom.indexAt(x) ?: current

/** The TalkBack text of one bar, as the PC chart reads its tooltip: `Sun 14:00: Total $1.20, Claude Code $1.00, Codex $0.20`. */
internal fun barDescription(title: String, total: String, rows: List<Pair<String, String>>): String =
    (listOf("$title: Total $total") + rows.map { "${it.first} ${it.second}" }).joinToString(", ")

/** The TalkBack summary of the chart: `Usage over time, 24 hours. Highest: 14:00, $1.20.` in the current unit. */
internal fun chartSummary(period: String, unit: String, starts: List<Long>, sums: List<Double>, metric: Metric): String {
    val head = "Usage over time, ${periodLabel(period)}."
    val top = sums.indices.maxByOrNull { sums[it] }?.takeIf { sums[it] > 0 } ?: return "$head No usage."
    val start = starts.getOrElse(top) { 0L }
    val name = if (unit == "hour") formatTime(start) else bucketLabel(start, unit, last = false, short = false)
    return "$head Highest: $name, ${formatValue(sums[top], metric)}."
}

/**
 * The x labels of an hourly or a daily chart at even steps: an hourly chart names the hours that start a 6-hour block on the phone
 * clock (00:00, 06:00, 12:00, 18:00; with the weekday of [hourWeekdays]), a daily chart each [chartLabelShown] day. When two
 * labels centered under their bars (inside [width]) come nearer than [gap], the step doubles.
 */
internal fun evenAxisLabels(starts: List<Long>, unit: String, centers: List<Float>, width: Float, gap: Float,
    measure: (String) -> Float): List<AxisLabel> {
    val n = centers.size
    val zone = ZoneId.systemDefault()
    val hourOf = { i: Int -> Instant.ofEpochMilli(starts.getOrElse(i) { 0L }).atZone(zone).let { if (it.minute == 0) it.hour else -1 } }
    var step = if (unit == "hour") 6 else (1 until n).firstOrNull { chartLabelShown(n, unit, n - 1 - it) } ?: 1
    while (true) {
        val ticks = (0 until n).filter { i -> if (unit == "hour") hourOf(i) >= 0 && hourOf(i) % step == 0 else (n - 1 - i) % step == 0 }
        val named = if (unit == "hour") hourWeekdays(starts, ticks) else emptySet()
        val labels = ticks.map { i ->
            val start = starts.getOrElse(i) { 0L }
            AxisLabel(i, if (unit == "hour") hourText(start, i in named) else bucketLabel(start, unit, last = false, short = true))
        }
        val boxes = labels.map { label ->
            val w = measure(label.text)
            val x = centers[label.index].coerceIn(w / 2, maxOf(w / 2, width - w / 2)) - w / 2
            x to x + w
        }
        // A 24-hour step leaves at most one label a day; it is the last try.
        if (boxes.zipWithNext().all { (a, b) -> a.second + gap <= b.first } || step >= (if (unit == "hour") 24 else n)) return labels
        step *= 2
    }
}

/** The tooltip series order: the series indexes high to low by [values]; ties keep the series order. */
internal fun tipOrder(values: List<Double>): List<Int> = values.indices.sortedByDescending { values[it] }

@Composable
private fun TipRow(label: String, value: String, swatch: Color, colors: ActivityColors) {
    Row(Modifier.fillMaxWidth().heightIn(min = 18.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).background(swatch, RoundedCornerShape(2.dp)))
        Text(label, fontSize = 12.sp, color = colors.text)
        Spacer(Modifier.weight(1f))
        Text(value, fontSize = 12.sp, style = figures, color = colors.text, modifier = Modifier.padding(start = 12.dp))
    }
}

@Composable
private fun TypeBlock(title: String, shares: List<TypeShare>, format: (Double) -> String, colors: ActivityColors) {
    Text(title, fontSize = 12.sp, color = colors.muted, modifier = Modifier.padding(bottom = 8.dp))
    val shown = shares.filter { it.value > 0 }
    Row(Modifier.fillMaxWidth().height(10.dp).semantics {
        contentDescription = shown.joinToString(", ") { "${it.label} ${format(it.value)}" }
    }, horizontalArrangement = Arrangement.spacedBy(1.dp)) {
        for (share in shown) Box(Modifier.weight(share.value.toFloat()).height(10.dp)
            .background(colors.tokens.getValue(share.key), RoundedCornerShape(2.dp)))
    }
    Spacer(Modifier.height(10.dp))
    for (share in shares) {
        Row(Modifier.fillMaxWidth().height(22.dp).semantics(mergeDescendants = true) {}, horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).background(colors.tokens.getValue(share.key), RoundedCornerShape(2.dp)))
            Text(share.label, fontSize = 12.sp, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(format(share.value), fontSize = 12.sp, style = figures, color = colors.text, maxLines = 1)
            Text(formatShare(share.share), fontSize = 12.sp, style = figures, color = colors.muted, textAlign = TextAlign.End,
                maxLines = 1, modifier = Modifier.width(52.dp))
        }
    }
}

/** The measure columns of Models and Sessions in order: the ranked measure first (Cost, then Tokens in Cost; Tokens, then Cost in Tokens). */
internal fun measureColumns(metric: Metric): List<String> = if (metric == Metric.COST) listOf("Cost", "Tokens") else listOf("Tokens", "Cost")

/** The TalkBack name of the ranked head: `Tokens, sorted from high to low`. */
internal fun rankedHeadName(metric: Metric): String = "${measureColumns(metric)[0]}, sorted from high to low"

private fun measureWidth(title: String) = if (title == "Cost") 80.dp else 64.dp

@Composable
private fun TableHeader(first: String, metric: Metric, colors: ActivityColors) {
    val header = TextStyle(fontSize = 11.sp, color = colors.muted)
    Row(Modifier.fillMaxWidth().height(30.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(first, style = header, modifier = Modifier.weight(1f))
        Text("App", style = header, modifier = Modifier.width(32.dp))
        val (ranked, other) = measureColumns(metric)
        // The ranked head: the text color, `↓` in a 12 dp column 4 dp before the right-aligned text.
        Row(Modifier.width(measureWidth(ranked)).clearAndSetSemantics { contentDescription = rankedHeadName(metric) },
            horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
            Text("↓", style = header.copy(color = colors.text), textAlign = TextAlign.End, modifier = Modifier.width(12.dp))
            Text(ranked, style = header.copy(color = colors.text), maxLines = 1)
        }
        Text(other, style = header, textAlign = TextAlign.End, modifier = Modifier.width(measureWidth(other)))
    }
    HorizontalDivider(thickness = 1.dp, color = colors.rule)
}

/** The Cost and Tokens cells of a Models or Sessions row in [measureColumns] order. */
@Composable
private fun MeasureCells(metric: Metric, cost: String, costInk: Color, tokens: String, tokensInk: Color) {
    for (title in measureColumns(metric)) {
        Text(if (title == "Cost") cost else tokens, fontSize = 12.sp, style = figures, color = if (title == "Cost") costInk else tokensInk,
            textAlign = TextAlign.End, maxLines = 1, modifier = Modifier.width(measureWidth(title)))
    }
}

@Composable
private fun ModelsTable(totals: UsageTotals, metric: Metric, colors: ActivityColors) {
    TableHeader("Model", metric, colors)
    for (row in modelRows(totals, metric)) {
        key(row.model, row.app) {
            Row(Modifier.fillMaxWidth().height(34.dp).semantics(mergeDescendants = true) {},
                horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(row.model, fontSize = 12.sp, style = figures, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f))
                Box(Modifier.width(32.dp)) {
                    Icon(painterResource(appMark(row.app)), contentDescription = appLabel(row.app), tint = colors.text, modifier = Modifier.size(14.dp))
                }
                MeasureCells(metric, formatCost(row.cost), if (row.cost == null) colors.muted else colors.text, formatTokens(row.tokens), colors.text)
            }
            HorizontalDivider(thickness = 1.dp, color = colors.rule)
        }
    }
}

/**
 * The TalkBack text of a Sessions row: `<title>, <app>, <machine>, <value>, <percent> of the cost` (`of the tokens` in Tokens);
 * the rest row has no app and no machine.
 */
internal fun sessionSpoken(title: String, app: String?, machine: String?, value: String, share: Double, metric: Metric): String =
    (listOf(title) + listOfNotNull(app, machine) + listOf(value, "${formatShare(share)} of the ${if (metric == Metric.COST) "cost" else "tokens"}"))
        .joinToString(", ")

/** The machine of a Sessions row sentence: its name, with ` (offline)` for an offline machine. */
internal fun sessionMachine(name: String, offline: Boolean): String = name + if (offline) " (offline)" else ""

/** The scope of the rows that the rest row button added: they reset when the period, the metric, or the machine chips change. */
internal fun sessionScope(period: String, metric: Metric, on: List<String>): List<Any> = listOf(period, metric, on)

/** The TalkBack name of the rest row button: `Show 8 more sessions` (the count of the next step). */
internal fun moreSessionsLabel(next: Int): String = "Show $next more session${if (next == 1) "" else "s"}"

/** The Sessions table, in the Models columns: the top sessions, then the muted rest row; each row is one TalkBack node. */
@Composable
private fun SessionsTable(sessions: SessionsView, machines: Map<String, ActivityMachine>, hues: Map<String, Color>, metric: Metric,
    colors: ActivityColors, onMore: () -> Unit) {
    TableHeader("Session", metric, colors)
    for (row in sessions.rows) {
        key(row.machineId, row.app, row.id) {
            val machine = machines[row.machineId]
            SessionLine(row.title, row.app, (hues[row.machineId] ?: colors.text) to machineOffline(machine),
                if (row.unpriced && row.cost == 0.0) null else row.cost, row.tokens, metric, false, colors,
                sessionSpoken(row.title, appLabel(row.app), sessionMachine(machine?.name.orEmpty(), machineOffline(machine)),
                    formatValue(row.value, metric), row.share, metric))
        }
    }
    sessions.other?.let {
        SessionLine(it.label, null, null, it.cost, it.tokens, metric, true, colors,
            sessionSpoken(it.label, null, null, formatValue(it.value, metric), it.share, metric),
            more = if (it.next > 0) moreSessionsLabel(it.next) else null, onMore = onMore)
    }
}

/**
 * One Sessions row: the machine [dot] (hue, offline) 6 dp before the title. With [more], the name of the rest row is a flat button
 * (the label, 6 dp, a muted 12 sp `▾`), at least 48 dp high, with the TalkBack name [more]; the cells then read the row sentence.
 */
@Composable
private fun SessionLine(title: String, app: String?, dot: Pair<Color, Boolean>?, cost: Double?, tokens: Long, metric: Metric, rest: Boolean,
    colors: ActivityColors, spoken: String, more: String? = null, onMore: () -> Unit = {}) {
    val ink = if (rest) colors.muted else colors.text
    Row(Modifier.fillMaxWidth().heightIn(min = 34.dp).then(if (more == null) Modifier.clearAndSetSemantics { contentDescription = spoken } else Modifier),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f)) {
            Row(if (more == null) Modifier else Modifier.heightIn(min = 48.dp).semantics { contentDescription = more }
                .clickable(role = Role.Button, onClick = onMore).padding(end = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                dot?.let { (hue, offline) -> MachineDot(hue, offline) }
                // A title is cut at its end, as the session titles elsewhere.
                Text(title, fontSize = 12.sp, color = ink, maxLines = 1, overflow = NAME_OVERFLOW,
                    modifier = Modifier.weight(1f, fill = false).clearAndSetSemantics {})
                if (more != null) Text("\u25be", fontSize = 12.sp, color = colors.muted, modifier = Modifier.clearAndSetSemantics {})
            }
        }
        Row(if (more == null) Modifier else Modifier.clearAndSetSemantics { contentDescription = spoken },
            horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            // The rest row has no app glyph: its name takes that column too, so that `Other sessions (3430)` and its arrow fit.
            if (!rest) Box(Modifier.width(32.dp)) {
                if (app != null) Icon(painterResource(appMark(app)), contentDescription = appLabel(app), tint = colors.text, modifier = Modifier.size(14.dp))
            }
            // An unpriced session with no priced part shows Unpriced (null), as an unpriced model.
            MeasureCells(metric, formatCost(cost), if (cost == null) colors.muted else ink, formatTokens(tokens), ink)
        }
    }
    HorizontalDivider(thickness = 1.dp, color = colors.rule)
}

/** The muted word of an overview row in place of its value: `No data`, or `Unpriced` (port of usage_row_value); null for a number. */
internal fun rowWord(row: UsageRow): String? = when {
    row.noData -> "No data"
    row.unpriced -> formatCost(null)
    else -> null
}
