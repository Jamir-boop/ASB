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

/** The name of a count strip bucket: the clock for an hour (`16:00`), else the date (`Oct 20`). */
fun stripBucketName(startMs: Long, unit: String): String = if (unit == "hour") formatTime(startMs) else formatDate(startMs)

/** Port of message_bucket_tip: `Oct 22: 84 messages, 2 not sent` or `14:00: 1 message`. */
fun messageBucketTip(startMs: Long, count: Int, bad: Int, unit: String): String =
    "${stripBucketName(startMs, unit)}: ${formatCount(count.toLong())} message${if (count == 1) "" else "s"}" +
        if (bad > 0) ", ${formatCount(bad.toLong())} not sent" else ""

/** Today, Yesterday, or the date, by local calendar day. */
fun dayText(ms: Long, nowMs: Long): String = when (ChronoUnit.DAYS.between(local(ms).toLocalDate(), local(nowMs).toLocalDate())) {
    0L -> "Today"
    1L -> "Yesterday"
    else -> formatDate(ms)
}

/** Short labels name the current bucket; month labels add the year at the first bucket and January; a week names its start. */
fun bucketLabel(startMs: Long, unit: String, last: Boolean, short: Boolean, first: Boolean = false): String = when (unit) {
    "hour" -> if (short && last) "Now" else formatTime(startMs)
    "week" -> when {
        !short -> "Week of ${formatDate(startMs)}"
        last -> "This week"
        else -> formatDate(startMs)
    }
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

/** The Usage chart title from the bucket unit (`Weekly cost`); a running scan adds ` (still reading)`. */
fun usageChartTitle(unit: String, cost: Boolean, scanning: Boolean): String =
    (when (unit) { "hour" -> "Hourly"; "week" -> "Weekly"; "month" -> "Monthly"; else -> "Daily" }) + (if (cost) " cost" else " tokens") +
        if (scanning) " (still reading)" else ""

/** The Usage Totals title: `Totals (still reading)` while a scan runs. */
fun usageTotalsTitle(scanning: Boolean): String = if (scanning) "Totals (still reading)" else "Totals"

const val USAGE_EMPTY_HINT = "Usage shows here after Codex, Claude Code, OpenCode, or another agent app runs on one of your machines."

/** The muted line under the Cache savings value. */
const val CACHE_SAVINGS_NOTE = "vs. uncached input price"

data class AxisLabel(val index: Int, val text: String)

/**
 * Port of usage_partial_first and usage_first_label: `From Jul 16` (months: `From Jul 16, 2024`) when the local day of the first
 * record ([firstMs]) is after the start day of the first week or month bucket, else null. A daily chart has no partial bucket.
 */
fun partialFirstLabel(unit: String, starts: List<Long>, firstMs: Long?): String? {
    if (unit !in setOf("week", "month") || firstMs == null || starts.isEmpty()) return null
    if (!local(firstMs).toLocalDate().isAfter(local(starts[0]).toLocalDate())) return null
    return "From ${formatDate(firstMs)}" + if (unit == "month") ", ${local(firstMs).year}" else ""
}

/**
 * Port of usage_bucket_progress: the running part of the current bucket that starts at [startMs], as `minute 29 of 60`,
 * `hour 17 of 24`, `day 1 of 7`, or `day 26 of 31`: the whole elapsed units at [nowMs] plus 1, of the units in the bucket. A day,
 * week, or month bucket starts at the PC's local midnight; the days are counted on the [zone] calendar from the [zone] midnight
 * nearest to that start (a daylight saving day has 23 or 25 hours, a month its own day count).
 */
fun bucketProgress(unit: String, startMs: Long, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String {
    val (word, done, total) = if (unit == "hour") Triple("minute", Math.floorDiv(nowMs - startMs, 60_000L), 60L) else {
        // The phone zone can differ from the PC zone: both times move to the phone midnight nearest to the PC midnight, so the
        // phone calendar counts the PC days.
        val date = Instant.ofEpochMilli(startMs).atZone(zone).toLocalDate()
        val before = date.atStartOfDay(zone).toInstant().toEpochMilli()
        val after = date.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
        val shift = if (startMs - before <= after - startMs) before - startMs else after - startMs
        val start = Instant.ofEpochMilli(startMs + shift).atZone(zone).toLocalDate()
        val days = ChronoUnit.DAYS.between(start, Instant.ofEpochMilli(nowMs + shift).atZone(zone).toLocalDate())
        when (unit) {
            "day" -> {
                val following = start.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
                Triple("hour", Math.floorDiv(nowMs - startMs, 3_600_000L), Math.round((following - startMs - shift) / 3_600_000.0))
            }
            "week" -> Triple("day", days, 7L)
            else -> Triple("day", days, Instant.ofEpochMilli(startMs + 14 * 86_400_000L).atZone(zone).toLocalDate().lengthOfMonth().toLong())
        }
    }
    return "$word ${(done + 1).coerceIn(1, total)} of $total"
}

/** The name of the current bucket, as the PC chart header: `This week so far`. */
fun currentBucketName(unit: String): String = when (unit) {
    "hour" -> "This hour so far"
    "week" -> "This week so far"
    "month" -> "This month so far"
    else -> "Today so far"
}

/**
 * The tooltip title of a chart bucket: the long name, or [first] (the partial first bucket). The current (last) bucket names its
 * running part at [nowMs], as the PC header: `This week so far · day 1 of 7` (without [nowMs]: `This week so far`).
 */
fun tooltipTitle(startMs: Long, unit: String, last: Boolean, first: String? = null, nowMs: Long? = null): String = when {
    !last -> first ?: bucketLabel(startMs, unit, last, short = false)
    nowMs == null -> currentBucketName(unit)
    else -> "${currentBucketName(unit)} · ${bucketProgress(unit, startMs, nowMs)}"
}

/**
 * The x labels of the Usage chart (port of usage_axis_labels): candidates from [chartLabelShown], each centered under its bar
 * and kept inside [width]; from the last bar to the first, a label is shown only when it ends [gap] before the label to its
 * right. Each label names its bucket, the last one too. Month labels are measured with the year, then show it on the leftmost
 * label and where the year changes. A partial first bucket has the label [first] (`From Jul 16`), which always shows when it
 * fits beside the last label; labels between them make room for it. A regular label keeps [endGap] (not [gap]) before an end
 * label: the last label, and the kept [first] label.
 */
fun axisLabels(starts: List<Long>, unit: String, centers: List<Float>, width: Float, gap: Float, measure: (String) -> Float,
    first: String? = null, endGap: Float = gap): List<AxisLabel> {
    val n = centers.size
    val text = { i: Int -> if (i == 0 && first != null) first else bucketLabel(starts.getOrElse(i) { 0L }, unit, last = false, short = true, first = true) }
    // The left x of a label: the last label ends at the right edge of the chart, the others are centered inside it.
    val place = { i: Int, w: Float -> if (i == n - 1) width - w else centers[i].coerceIn(w / 2, maxOf(w / 2, width - w / 2)) - w / 2 }
    val shown = mutableListOf<Int>()
    var nextLeft = Float.POSITIVE_INFINITY
    for (i in n - 1 downTo 0) {
        if (!chartLabelShown(n, unit, i)) continue
        val w = measure(text(i))
        if (i == n - 1 || place(i, w) + w <= nextLeft - if (shown.size == 1 || (i == 0 && first != null)) endGap else gap) {
            shown += i
            nextLeft = place(i, w)
        }
    }
    if (first != null && n > 1 && shown.last() != 0) {
        val end = place(0, measure(first)) + measure(first)
        if (end <= place(n - 1, measure(text(n - 1))) - endGap) {
            while (place(shown.last(), measure(text(shown.last()))) < end + endGap) shown.removeAt(shown.lastIndex)
            shown += 0
        }
    }
    var year: Int? = null
    return shown.reversed().map { i ->
        val start = starts.getOrElse(i) { 0L }
        if (i == 0 && first != null) return@map AxisLabel(0, first).also { year = monthOf(start).year }
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
