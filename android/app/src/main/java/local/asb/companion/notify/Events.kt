package local.asb.companion.notify

import local.asb.companion.data.Thread
import local.asb.companion.ui.limitLeft

const val BIT_DONE = 1
const val BIT_FAILED = 2
const val BIT_INPUT = 4
private const val BIT_LIMITED = 8

fun bits(row: Thread): Int {
    if (row.archived) return 0
    // A Codex chat with native read state shows its result only as native attention and the last outcome.
    val native = row.nativeAttention && row.state == "idle"
    val nativeFailed = native && row.lastOutcome == "failed"
    return (if (row.completionAttention || (native && !nativeFailed)) BIT_DONE else 0) or
        (if (row.failedAttention || nativeFailed) BIT_FAILED else 0) or
        (if (row.questionAttention || row.actionRequired) BIT_INPUT else 0)
}

data class Event(val row: Thread, val kind: Int)

fun diff(
    baseline: Map<String, Int>?,
    threads: List<Thread>,
    nowMs: Long = System.currentTimeMillis(),
): List<Event> {
    if (baseline == null) return emptyList()
    return buildList {
        for (row in threads) {
            // The key is the same on every engine of a group, so a change of engine does not post again.
            val old = baseline[row.key] ?: 0
            var added = bits(row) and old.inv()
            // Stored attention survives a limit; suppress its first restoration after the reset.
            // shortcut: A result after reset can be missed between polls; use event history if all results must notify.
            if (limitLeft(row, nowMs) > 0 || old and BIT_LIMITED != 0) added = added and BIT_INPUT
            if (added and BIT_INPUT != 0) add(Event(row, BIT_INPUT))
            if (added and BIT_FAILED != 0) add(Event(row, BIT_FAILED))
            if (added and BIT_DONE != 0) add(Event(row, BIT_DONE))
        }
    }
}

// Rows missing from one update keep their bits, so a skipped scan cannot replay an old mark.
fun update(
    baseline: Map<String, Int>?,
    threads: List<Thread>,
    nowMs: Long = System.currentTimeMillis(),
): Map<String, Int> = (baseline ?: emptyMap()).toMutableMap().apply {
    for (row in threads) {
        val current = bits(row)
        put(row.key, if (!row.archived && limitLeft(row, nowMs) > 0) {
            (current and BIT_INPUT) or ((baseline?.get(row.key) ?: 0) and (BIT_DONE or BIT_FAILED)) or BIT_LIMITED
        } else current)
    }
}
