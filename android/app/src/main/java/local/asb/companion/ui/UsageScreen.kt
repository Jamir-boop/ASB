package local.asb.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.math.BigDecimal
import java.math.MathContext
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import local.asb.companion.R
import local.asb.companion.data.ActivityUsage
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
import local.asb.companion.data.usageAxis
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
                            Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()),
                                horizontalArrangement = Arrangement.spacedBy(6.dp)) {
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
                    current == null && error != null -> ActivityError(error.orEmpty(), colors) { attempt++ }
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

@Composable
private fun UsageEmpty(period: String, colors: ActivityColors, onAllTime: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(48.dp), verticalArrangement = Arrangement.spacedBy(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally) {
        EmptyBlock(R.drawable.ic_usage, if (period == "all") "No usage yet" else "No usage in the last ${periodLabel(period)}",
            "Usage shows here after an agent app runs.", colors)
        if (period != "all") AccentButton("Show all time", colors, Modifier.padding(top = 4.dp), onClick = onAllTime)
    }
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
        for (row in machineRows(totals, metric)) {
            val machine = machines[row.key]
            UsageRowView(row, metric, colors, sub = machine?.let(::machineStateLine),
                spoken = listOf(machine?.name.orEmpty(), machine?.let(::machineStateLine).orEmpty(), formatValue(row.value, metric),
                    formatShare(row.share), appSplit(row, metric)).filter { it.isNotEmpty() }.joinToString(", "), bar = {
                val segments = row.segments.filter { it.second > 0 }
                Row(Modifier.fillMaxWidth(row.share.toFloat().coerceIn(0f, 1f)).height(10.dp), horizontalArrangement = Arrangement.spacedBy(1.dp)) {
                    for ((app, value) in segments) Box(Modifier.weight(value.toFloat()).height(10.dp)
                        .background(appColor(app, colors), RoundedCornerShape(2.dp)))
                }
            }) {
                MachineDot(hues[row.key] ?: colors.text, machineOffline(machine))
                Text(machine?.name.orEmpty(), fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = colors.text,
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
                Text(appLabel(row.key), fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = colors.text,
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
                Text(row.key, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = colors.text,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (metric == Metric.COST) unpricedNote(totals, ::formatTokens)?.let {
            Text(it, fontSize = 12.sp, color = colors.muted, modifier = Modifier.padding(top = 10.dp))
        }
        Spacer(Modifier.height(28.dp))
        UsageChart(reply, totals, metric, byMachine, onSplit, hues, colors)
        Spacer(Modifier.height(28.dp))
        SectionTitle(if (reply.scan.complete) "Totals" else "Totals so far", colors)
        Spacer(Modifier.height(6.dp))
        usageFigures(totals).chunked(2).forEach { pair ->
            Row(Modifier.fillMaxWidth().padding(bottom = 16.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                for (figure in pair) Column(Modifier.weight(1f).semantics(mergeDescendants = true) {}) {
                    Text(figure.label, fontSize = 12.sp, color = colors.muted)
                    Text(figure.tokens?.let(::formatTokens) ?: formatCost(figure.cost ?: 0.0), fontSize = 20.sp, style = figures,
                        color = colors.text)
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
            Box(Modifier.weight(1f).height(10.dp).background(colors.track, RoundedCornerShape(2.dp))) { bar() }
            Text(if (row.unpriced) formatCost(null) else formatValue(row.value, metric), fontSize = 13.sp, style = figures,
                color = if (row.unpriced) colors.muted else colors.text, textAlign = TextAlign.End,
                maxLines = 1, modifier = Modifier.width(84.dp))
            Text(if (row.unpriced) "" else formatShare(row.share), fontSize = 12.sp, color = colors.muted, textAlign = TextAlign.End, maxLines = 1,
                modifier = Modifier.width(44.dp))
        }
        HorizontalDivider(thickness = 1.dp, color = colors.rule)
    }
}

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
    val sub = tapped?.let(arcLabel) ?: if (metric == Metric.COST) "at API prices" else "processed tokens"
    // The third center line, only when nothing is tapped.
    val note = if (tapped != null) "" else usageRingNote(!reply.scan.complete, totals.machineIds.size, reply.machines.size,
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
                drawPath(sectorPath(c + shift, arc.r0 * k, arc.r1 * k, arc.a0.toFloat(), arc.a1.toFloat()), arcColor(arc))
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
    Text((when (unit) { "hour" -> "Hourly "; "month" -> "Monthly "; else -> "Daily " }) + if (metric == Metric.COST) "cost" else "tokens", fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold, color = colors.text)
    Spacer(Modifier.height(6.dp))
    ChoiceRow(listOf("app" to "By app", "machine" to "By machine"), if (byMachine) "machine" else "app") { onSplit(it == "machine") }
    Spacer(Modifier.height(12.dp))
    val sums = bars.map { it.sum() }
    val (step, lines) = usageAxis(sums.maxOrNull() ?: 0.0)
    // The top of the plot is the top line.
    val yMax = step * lines
    var width by remember { mutableIntStateOf(0) }
    Box(Modifier.fillMaxWidth().height(242.dp).onSizeChanged { width = it.width }) {
        val n = bars.size
        Canvas(Modifier.fillMaxSize().semantics { contentDescription = "Usage over time" }.pointerInput(n) {
            detectTapGestures { point ->
                val dp = density.density
                val left = 48 * dp
                val gap = (if (n >= 90) 1 else 2) * dp
                val bw = (size.width - left - gap * (n - 1)) / n
                val i = ((point.x - left) / (bw + gap)).toInt()
                tapped = if (point.x >= left && i in 0 until n && i != tapped) i else null
            }
        }) {
            if (n == 0) return@Canvas
            val dp = this.density
            val plotB = 220 * dp
            val plotT = 8 * dp
            val left = 48 * dp
            val y = { v: Double -> plotB - (plotB - plotT) * (v / yMax).toFloat() }
            val axis = TextStyle(color = colors.muted, fontSize = 11.sp)
            for (k in 1..lines) {
                val gy = y(step * k)
                drawLine(colors.rule, Offset(left, gy), Offset(size.width, gy), 1 * dp, pathEffect = PathEffect.dashPathEffect(floatArrayOf(3 * dp, 3 * dp)))
                val layout = measurer.measure(axisLabel(step * k, metric), axis, maxLines = 1)
                drawText(layout, topLeft = Offset(left - 8 * dp - layout.size.width, gy - layout.size.height / 2f))
            }
            val gap = (if (n >= 90) 1 else 2) * dp
            val bw = (size.width - left - gap * (n - 1)) / n
            bars.forEachIndexed { i, values ->
                val x = left + i * (bw + gap)
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
                    }, seriesColor(series[s]))
                }
                if (i == tapped && sums[i] > 0) {
                    val top = y(sums[i])
                    drawRect(colors.text, Offset(x - .5f * dp, top - .5f * dp), Size(bw + dp, plotB - top + dp), style = Stroke(1 * dp))
                }
            }
            val centers = List(n) { left + it * (bw + gap) + bw / 2 }
            for (label in axisLabels(starts, unit, centers, size.width, 4 * dp) { measurer.measure(it, axis, maxLines = 1).size.width.toFloat() }) {
                val layout = measurer.measure(label.text, axis, maxLines = 1)
                val w = layout.size.width.toFloat()
                // The last label ends at the right edge of the chart.
                val cx = if (label.index == n - 1) size.width - w / 2 else centers[label.index].coerceIn(w / 2, size.width - w / 2)
                drawText(layout, topLeft = Offset(cx - layout.size.width / 2f, plotB + 15 * dp - layout.size.height / 2f))
            }
        }
        tapped?.let { i ->
            var tipSize by remember { mutableStateOf(IntSize.Zero) }
            val dp = density.density
            val left = 48 * dp
            val gap = (if (n >= 90) 1 else 2) * dp
            val bw = (width - left - gap * (n - 1)) / n
            val x = left + i * (bw + gap)
            // Right of the bar when it is not one of the last two and has more room on its right, else left; inside the chart.
            val right = i < n - 2 && width - (x + bw) > x - left
            val tipLeft = (if (right) x + bw + 8 * dp else x - tipSize.width - 8 * dp)
                .coerceIn(0f, (width - tipSize.width).toFloat().coerceAtLeast(0f))
            // Centered on the bar top, inside the 242 dp chart.
            val barTop = 220 * dp - (212 * dp) * (sums[i] / yMax).toFloat()
            val tipTop = (barTop - tipSize.height / 2f).coerceIn(0f, (242 * dp - tipSize.height).coerceAtLeast(0f))
            Column(Modifier.offset { IntOffset(tipLeft.roundToInt(), tipTop.roundToInt()) }.onSizeChanged { tipSize = it }
                .widthIn(min = 150.dp).background(colors.background, RoundedCornerShape(4.dp)).border(1.dp, colors.edge, RoundedCornerShape(4.dp))
                .padding(horizontal = 10.dp, vertical = 8.dp).semantics(mergeDescendants = true) {}) {
                Text(tooltipTitle(starts.getOrElse(i) { 0L }, unit, i == n - 1), fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold, color = colors.text, modifier = Modifier.padding(bottom = 4.dp))
                TipRow("Total", formatValue(sums[i], metric), colors.accent, colors)
                HorizontalDivider(Modifier.padding(vertical = 4.dp), thickness = 1.dp, color = colors.rule)
                // The series high to low by their value in this bucket; a stable sort keeps the series order for ties.
                for (s in tipOrder(bars[i])) TipRow(seriesLabel(series[s]), formatValue(bars[i][s], metric), seriesColor(series[s]), colors)
            }
        }
    }
}

/** The tooltip series order: the series indexes high to low by [values]; ties keep the series order. */
internal fun tipOrder(values: List<Double>): List<Int> = values.indices.sortedByDescending { values[it] }

@Composable
private fun TipRow(label: String, value: String, swatch: Color, colors: ActivityColors) {
    Row(Modifier.height(18.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).background(swatch, RoundedCornerShape(2.dp)))
        Text(label, fontSize = 12.sp, color = colors.text, maxLines = 1)
        Spacer(Modifier.weight(1f))
        Text(value, fontSize = 12.sp, style = figures, color = colors.text, maxLines = 1, modifier = Modifier.padding(start = 12.dp))
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

@Composable
private fun ModelsTable(totals: UsageTotals, metric: Metric, colors: ActivityColors) {
    val header = TextStyle(fontSize = 11.sp, color = colors.muted)
    Row(Modifier.fillMaxWidth().height(30.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Model", style = header, modifier = Modifier.weight(1f))
        Text("App", style = header, modifier = Modifier.width(32.dp))
        Text("Cost", style = header, textAlign = TextAlign.End, modifier = Modifier.width(80.dp))
        Text("Tokens", style = header, textAlign = TextAlign.End, modifier = Modifier.width(64.dp))
    }
    HorizontalDivider(thickness = 1.dp, color = colors.rule)
    for (row in modelRows(totals, metric)) {
        key(row.model, row.app) {
            Row(Modifier.fillMaxWidth().height(34.dp).semantics(mergeDescendants = true) {},
                horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(row.model, fontSize = 12.sp, style = figures, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f))
                Box(Modifier.width(32.dp)) {
                    Icon(painterResource(appMark(row.app)), contentDescription = appLabel(row.app), tint = colors.text, modifier = Modifier.size(14.dp))
                }
                Text(formatCost(row.cost), fontSize = 12.sp, style = figures,
                    color = if (row.cost == null) colors.muted else colors.text, textAlign = TextAlign.End, maxLines = 1,
                    modifier = Modifier.width(80.dp))
                Text(formatTokens(row.tokens), fontSize = 12.sp, style = figures, color = colors.text, textAlign = TextAlign.End,
                    maxLines = 1, modifier = Modifier.width(64.dp))
            }
            HorizontalDivider(thickness = 1.dp, color = colors.rule)
        }
    }
}
