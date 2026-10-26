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

// Port of duration_text.
fun durationText(seconds: Long): String {
    val total = seconds.coerceAtLeast(0)
    val hours = total / 3600
    val minutes = total / 60 % 60
    val remainder = total % 60
    return when {
        hours > 0 -> "${hours}h${minutes}m"
        minutes > 0 -> "${minutes}m${remainder}s"
        else -> "${remainder}s"
    }
}

// Port of spoken_duration.
fun spokenDuration(seconds: Long): String {
    val total = seconds.coerceAtLeast(0)
    val hours = total / 3600
    val minutes = total / 60 % 60
    val remainder = total % 60
    fun unit(count: Long, name: String) = "$count $name" + if (count == 1L) "" else "s"
    return when {
        hours > 0 -> unit(hours, "hour") + if (minutes > 0) " " + unit(minutes, "minute") else ""
        minutes > 0 -> unit(minutes, "minute") + if (remainder > 0) " " + unit(remainder, "second") else ""
        else -> unit(remainder, "second")
    }
}

// Port of limit_text: the reset countdown shows days and hours from 24 hours on (weekly limits).
fun limitText(seconds: Long): String {
    val days = seconds.coerceAtLeast(0) / 86_400
    return if (days > 0) "${days}d${seconds % 86_400 / 3600}h" else durationText(seconds)
}

// Port of spoken_limit.
fun spokenLimit(seconds: Long): String {
    val days = seconds.coerceAtLeast(0) / 86_400
    if (days == 0L) return spokenDuration(seconds)
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

// The card state word: an Idle row after a failed or usage-limit stop says Stopped; the filters keep stateLabel.
fun cardStateLabel(row: Thread): String =
    if (row.state == "idle" && row.lastOutcome in setOf("failed", "limit")) "Stopped" else stateLabel(row.state)

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

fun formatTime(ms: Long): String = TIME.format(local(ms))

fun formatDate(ms: Long): String = DATE.format(local(ms))

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
        val month = local(startMs)
        when {
            !short -> DateTimeFormatter.ofPattern("MMMM yyyy", Locale.US).format(month)
            last -> "This month"
            else -> DateTimeFormatter.ofPattern(if (first || month.monthValue == 1) "MMM yyyy" else "MMM", Locale.US).format(month)
        }
    }
    else -> if (short && last) "Today" else formatDate(startMs)
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

/** The Usage machine row line: Local, Connected, Offline, or Offline · last report Oct 25, 14:30. */
fun machineStateLine(machine: ActivityMachine): String = lastReportText(machine).let { report ->
    if (report.isEmpty()) machineStateText(machine) else "Offline · last report" + report.removePrefix("Last report")
}
