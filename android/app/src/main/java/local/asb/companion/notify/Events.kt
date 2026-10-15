package local.asb.companion.notify

import local.asb.companion.data.Thread

const val BIT_DONE = 1
const val BIT_FAILED = 2
const val BIT_INPUT = 4

fun bits(row: Thread): Int {
    if (row.archived) return 0
    return (if (row.completionAttention) BIT_DONE else 0) or
        (if (row.failedAttention) BIT_FAILED else 0) or
        (if (row.questionAttention || row.actionRequired) BIT_INPUT else 0)
}

data class Event(val row: Thread, val kind: Int)

fun diff(baseline: Map<String, Int>?, threads: List<Thread>): List<Event> {
    if (baseline == null) return emptyList()
    return buildList {
        for (row in threads) {
            val added = bits(row) and (baseline[row.id] ?: 0).inv()
            if (added and BIT_INPUT != 0) add(Event(row, BIT_INPUT))
            if (added and BIT_FAILED != 0) add(Event(row, BIT_FAILED))
            if (added and BIT_DONE != 0) add(Event(row, BIT_DONE))
        }
    }
}

fun update(threads: List<Thread>): Map<String, Int> = threads.associate { it.id to bits(it) }
