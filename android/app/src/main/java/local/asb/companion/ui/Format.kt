package local.asb.companion.ui

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

// The top bar connection text, for example "PC · Live · ZeroTier". An offline phone has no current path.
fun connectionText(serverName: String, offline: Boolean, pathLabel: String?): String =
    listOfNotNull(serverName, if (offline) "Offline" else "Live", pathLabel?.takeUnless { offline }).joinToString(" · ")

// Search mode stays open while a query is set, for example after a rotation or a return to the screen.
fun searchOpen(opened: Boolean, query: String): Boolean = opened || query.isNotEmpty()
