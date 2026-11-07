package local.asb.companion.ui

import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import local.asb.companion.data.ActivityMachine
import local.asb.companion.data.UsagePrices
import local.asb.companion.data.UsageScan
import local.asb.companion.data.Thread
import local.asb.companion.data.chartLabelShown

// Port of whole_minutes: no time shows seconds. A Working time rounds down, a countdown rounds up.
fun wholeMinutes(seconds: Long, roundUp: Boolean = false): Long {
    val total = seconds.coerceAtLeast(0)
    return total / 60 + if (roundUp && total % 60 > 0) 1 else 0
}

// Port of duration_text: hours and minutes, the minutes of a two-unit time with two digits (1h05m). A Working time shows <1m
// in its first minute.
fun durationText(seconds: Long, roundUp: Boolean = false): String {
    val total = wholeMinutes(seconds, roundUp)
    if (total == 0L) return if (roundUp) "0m" else "<1m"
    val hours = total / 60
    val minutes = total % 60
    return if (hours > 0) "${hours}h${minutes.toString().padStart(2, '0')}m" else "${minutes}m"
}

// Port of spoken_duration.
fun spokenDuration(seconds: Long, roundUp: Boolean = false): String {
    val total = wholeMinutes(seconds, roundUp)
    if (total == 0L) return if (roundUp) "0 minutes" else "less than a minute"
    val hours = total / 60
    val minutes = total % 60
    fun unit(count: Long, name: String) = "$count $name" + if (count == 1L) "" else "s"
    return when {
        hours == 0L -> unit(minutes, "minute")
        minutes > 0 -> unit(hours, "hour") + " " + unit(minutes, "minute")
        else -> unit(hours, "hour")
    }
}

// Port of limit_text: the reset countdown shows days and hours from 24 hours on (weekly limits), else hours and minutes rounded up,
// at most 23h59m.
fun limitText(seconds: Long): String {
    val days = seconds.coerceAtLeast(0) / 86_400
    if (days > 0) return "${days}d${(seconds % 86_400 / 3600).toString().padStart(2, '0')}h"
    return durationText(minOf(seconds, 86_340L), roundUp = true)
}

// Port of spoken_limit.
fun spokenLimit(seconds: Long): String {
    val days = seconds.coerceAtLeast(0) / 86_400
    if (days == 0L) return spokenDuration(minOf(seconds, 86_340L), roundUp = true)
    val hours = seconds % 86_400 / 3600
    fun unit(count: Long, name: String) = "$count $name" + if (count == 1L) "" else "s"
    return unit(days, "day") + if (hours > 0) " " + unit(hours, "hour") else ""
}

// Port of working_duration (without the state check; the caller passes a Working start).
fun workingDuration(workingSinceMs: Long, nowMs: Long): String {
    if (workingSinceMs <= 0 || workingSinceMs > nowMs) return ""
    return durationText((nowMs - workingSinceMs) / 1000)
}

// Port of the date part of row_meta.
fun idleAge(updatedAtMs: Long, nowMs: Long): String {
    if (updatedAtMs <= 0) return "No date"
    if (updatedAtMs >= nowMs) return "Just now"
    val age = nowMs - updatedAtMs
    return when {
        age < 60_000 -> "Just now"
        age < 3_600_000 -> "${age / 60_000}m ago"
        age < 86_400_000 -> "${age / 3_600_000}h ago"
        else -> "${age / 86_400_000}d ago"
    }
}

fun stateLabel(state: String): String = when (state) {
    "working" -> "Working"
    "waiting" -> "Waiting"
    "idle" -> "Idle"
    else -> "Unknown"
}

// The card state word: an Idle row says Failed after a failed task and Stopped after a stop or a usage-limit stop,
// until the next task starts (also after Read); the filters and sorting keep stateLabel.
fun cardStateLabel(row: Thread): String = when {
    row.state != "idle" -> stateLabel(row.state)
    row.lastOutcome == "failed" -> "Failed"
    row.lastOutcome in setOf("stopped", "limit") -> "Stopped"
    else -> stateLabel(row.state)
}

// The top bar connection text, for example "PC · Live · ZeroTier". An offline phone has no current path.
fun connectionText(serverName: String, offline: Boolean, pathLabel: String?): String =
    listOfNotNull(serverName, if (offline) "Offline" else "Live", pathLabel?.takeUnless { offline }).joinToString(" · ")

// Search mode stays open while a query is set, for example after a rotation or a return to the screen.
fun searchOpen(opened: Boolean, query: String): Boolean = opened || query.isNotEmpty()

// Messages and Usage formats, as the GTK windows (activity contract 5). Locale.US for grouping, decimals, and months.

fun formatCount(value: Long): String = String.format(Locale.US, "%,d", value)

fun formatCost(value: Double?): String = if (value == null) "Unpriced" else "$" + String.format(Locale.US, "%,.2f", value)

// Half up on the shortest decimal form, as JavaScript toFixed shows these values.
private fun fixed(value: Double, digits: Int): BigDecimal = BigDecimal.valueOf(value).setScale(digits, RoundingMode.HALF_UP)

fun formatTokens(value: Long): String {
    if (value < 1000) return value.toString()
    val thousands = fixed(value / 1e3, 1)
    if (thousands < BigDecimal(1000)) return thousands.toPlainString() + "K"
    val millions = fixed(value / 1e6, 1)
    if (millions < BigDecimal(1000)) return millions.toPlainString() + "M"
    return fixed(value / 1e9, 2).toPlainString() + "B"
}

fun formatShare(fraction: Double): String = fixed(fraction * 100, 1).toPlainString() + "%"

private val TIME = DateTimeFormatter.ofPattern("HH:mm", Locale.US)
private val DATE = DateTimeFormatter.ofPattern("MMM d", Locale.US)

private fun local(ms: Long) = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault())

// A month start is the PC's local midnight; mid-month names the PC's month also in a phone time zone west of the PC.
private fun monthOf(startMs: Long) = local(startMs + 14 * 86_400_000L)

fun formatTime(ms: Long): String = TIME.format(local(ms))

fun formatDate(ms: Long): String = DATE.format(local(ms))

private val WEEKDAY = DateTimeFormatter.ofPattern("EEE", Locale.US)

/** Port of message_time: the clock in 24 hours and for today, the weekday and the clock within 6 days, else the date and the clock. */
fun messageTime(ms: Long, nowMs: Long, period: String): String {
    val days = ChronoUnit.DAYS.between(local(ms).toLocalDate(), local(nowMs).toLocalDate())
    if (period == "24h" || days <= 0) return formatTime(ms)
    return "${if (days <= 6) WEEKDAY.format(local(ms)) else formatDate(ms)} ${formatTime(ms)}"
}

/** Today, Yesterday, or the date, by local calendar day. */
fun dayText(ms: Long, nowMs: Long): String = when (ChronoUnit.DAYS.between(local(ms).toLocalDate(), local(nowMs).toLocalDate())) {
    0L -> "Today"
    1L -> "Yesterday"
    else -> formatDate(ms)
}

/** Short labels name the current bucket; month labels add the year at the first bucket and January. */
fun bucketLabel(startMs: Long, unit: String, last: Boolean, short: Boolean, first: Boolean = false): String = when (unit) {
    "hour" -> if (short && last) "Now" else formatTime(startMs)
    "month" -> {
        val month = monthOf(startMs)
        when {
            !short -> DateTimeFormatter.ofPattern("MMMM yyyy", Locale.US).format(month)
            last -> "This month"
            else -> DateTimeFormatter.ofPattern(if (first || month.monthValue == 1) "MMM yyyy" else "MMM", Locale.US).format(month)
        }
    }
    else -> if (short && last) "Today" else formatDate(startMs)
}

data class AxisLabel(val index: Int, val text: String)

/** The tooltip title of a chart bucket: the long name; the current bucket is not complete (`October 2026 · so far`). */
fun tooltipTitle(startMs: Long, unit: String, last: Boolean): String =
    bucketLabel(startMs, unit, last, short = false) + if (last) " · so far" else ""

/**
 * The x labels of the Usage chart (port of usage_axis_labels): candidates from [chartLabelShown], each centered under its bar
 * and kept inside [width]; from the last bar to the first, a label is shown only when it ends [gap] before the label to its
 * right. Each label names its bucket, the last one too. Month labels are measured with the year, then show it on the leftmost
 * label and where the year changes.
 */
fun axisLabels(starts: List<Long>, unit: String, centers: List<Float>, width: Float, gap: Float, measure: (String) -> Float): List<AxisLabel> {
    val n = centers.size
    val shown = mutableListOf<Int>()
    var nextLeft = Float.POSITIVE_INFINITY
    for (i in n - 1 downTo 0) {
        if (!chartLabelShown(n, unit, i)) continue
        val start = starts.getOrElse(i) { 0L }
        val last = i == n - 1
        val w = measure(bucketLabel(start, unit, last = false, short = true, first = true))
        // The last label ends at the right edge of the chart.
        val cx = if (last) width - w / 2 else centers[i].coerceIn(w / 2, maxOf(w / 2, width - w / 2))
        if (last || cx + w / 2 <= nextLeft - gap) {
            shown += i
            nextLeft = cx - w / 2
        }
    }
    var year: Int? = null
    return shown.reversed().map { i ->
        val start = starts.getOrElse(i) { 0L }
        if (unit != "month") return@map AxisLabel(i, bucketLabel(start, unit, last = false, short = true))
        val y = monthOf(start).year
        AxisLabel(i, bucketLabel(start, unit, last = false, short = true, first = y != year)).also { year = y }
    }
}

fun machineStateText(machine: ActivityMachine): String = when (machine.state) {
    "local" -> "Local"
    "online" -> "Connected"
    else -> "Offline"
}

/** Last report Oct 25, 14:30; "" when the machine is not offline or never reported. */
fun lastReportText(machine: ActivityMachine): String =
    if (machineStateText(machine) == "Offline" && machine.lastReportAtMs > 0)
        "Last report ${formatDate(machine.lastReportAtMs)}, ${formatTime(machine.lastReportAtMs)}" else ""

/** The Usage toolbar price line: Prices: LiteLLM, Oct 26 (the day of the download), loading, or not available. */
fun pricesText(prices: UsagePrices): String = when (prices.status) {
    "fresh", "cached" -> prices.fetchedAtMs?.let { "Prices: ${prices.source.ifEmpty { "LiteLLM" }}, ${formatDate(it)}" }.orEmpty()
    "loading" -> "Prices: loading"
    "unavailable" -> "Prices: not available"
    else -> ""
}

/** The Usage scan line: "" when complete, Reading usage before the engine lists the files, else the file counts. */
fun scanText(scan: UsageScan): String = when {
    scan.complete -> ""
    scan.files <= 0 -> "Reading usage"
    else -> "Reading usage: ${formatCount(scan.scannedFiles.toLong())} of ${formatCount(scan.files.toLong())} files"
}

/** The Usage machine row line: Local, Connected, Offline, or Offline · seen Oct 25, 14:30. */
fun machineStateLine(machine: ActivityMachine): String = lastReportText(machine).let { report ->
    if (report.isEmpty()) machineStateText(machine) else "Offline · seen" + report.removePrefix("Last report")
}

/**
 * Port of facts_lines: the lines of [line] (facts joined by ` · `) in at most [width]. A line breaks only between two facts and
 * drops the ` · ` there; the words of a fact keep no-break spaces, so only a fact wider than [width] breaks inside.
 */
fun factLines(line: String, width: Float, measure: (String) -> Float): List<String> {
    val lines = mutableListOf<String>()
    for (fact in line.split(" · ").map { it.replace(' ', '\u00a0') }) {
        if (lines.isNotEmpty() && measure("${lines.last()} · $fact") <= width) lines[lines.size - 1] += " · $fact" else lines += fact
    }
    return lines
}

/** The Compact state text: the reset countdown, or the state word and the Working time in whole minutes. */
fun compactStateText(row: Thread, nowMs: Long): String {
    val left = limitLeft(row, nowMs)
    val working = if (row.state == "working") workingDuration(row.workingSinceMs, nowMs) else ""
    return if (left > 0) "Resets in ${limitText(left)}" else cardStateLabel(row) + if (working.isNotEmpty()) " · $working" else ""
}
