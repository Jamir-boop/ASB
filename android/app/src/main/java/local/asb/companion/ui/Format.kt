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

fun workingDuration(workingSinceMs: Long, nowMs: Long): String {
    if (workingSinceMs <= 0 || workingSinceMs > nowMs) return ""
    val seconds = (nowMs - workingSinceMs) / 1000
    val minutes = seconds / 60
    val hours = minutes / 60
    return when {
        hours > 0 -> "${hours}h ${minutes % 60}m"
        minutes > 0 -> "${minutes}m ${(seconds % 60).toString().padStart(2, '0')}s"
        else -> "${seconds}s"
    }
}

fun idleAge(updatedAtMs: Long, nowMs: Long): String {
    if (updatedAtMs <= 0) return "No date"
    if (updatedAtMs >= nowMs) return "now"
    val age = nowMs - updatedAtMs
    return when {
        age < 60_000 -> "now"
        age < 3_600_000 -> "${age / 60_000}m"
        age < 86_400_000 -> "${age / 3_600_000}h"
        else -> "${age / 86_400_000}d"
    }
}

fun stateLabel(state: String): String = when (state) {
    "working" -> "Working"
    "waiting" -> "Waiting"
    "idle" -> "Idle"
    else -> "Unknown"
}
