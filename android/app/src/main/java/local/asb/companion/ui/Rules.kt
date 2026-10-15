package local.asb.companion.ui

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.math.abs
import kotlin.math.hypot
import local.asb.companion.data.Message
import local.asb.companion.data.Thread

val STATES = listOf("working", "waiting", "idle", "unknown")
const val MESSAGE_MAX_AGE_MS = 30_000L
const val MESSAGE_FLIGHT_LIMIT = 6

data class Filter(
    val query: String = "",
    val app: String = "all",
    val states: Set<String> = STATES.toSet(),
    val archived: Boolean = false,
    val pendingOnly: Boolean = false,
    val drawerOnly: Boolean = false,
)

data class MenuAction(val label: String, val action: String)

private const val PYTHON_SPACE = """[\u0009-\u000D\u001C-\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]"""
private val pythonSpace = Regex(PYTHON_SPACE)
private val providerPrefix = Regex(
    "^$PYTHON_SPACE*(cl|claude|cx|codex)$PYTHON_SPACE*:$PYTHON_SPACE*(.*)$",
    setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
)

// Pin Unicode 15.1 so Android and JVM tests use the same desktop case-fold rules.
private val casefoldMappings by lazy {
    val stream = checkNotNull(Filter::class.java.getResourceAsStream("/unicode/CaseFolding-15.1.0.txt")) {
        "The Unicode 15.1 case-fold table is missing."
    }
    stream.bufferedReader(Charsets.UTF_8).useLines { lines ->
        lines.filter { it.isNotBlank() && !it.startsWith("#") }.associate { line ->
            val fields = line.split(';')
            fields[0].toInt(16) to buildString {
                for (codePoint in fields[2].split(' ')) appendCodePoint(codePoint.toInt(16))
            }
        }
    }
}

internal fun casefold(value: String): String = buildString {
    value.codePoints().forEach { codePoint ->
        val mapping = casefoldMappings[codePoint]
        if (mapping == null) appendCodePoint(codePoint) else append(mapping)
    }
}

private fun compareIds(left: String, right: String): Int {
    var first = 0
    var second = 0
    while (first < left.length && second < right.length) {
        val a = left.codePointAt(first)
        val b = right.codePointAt(second)
        if (a != b) return a.compareTo(b)
        first += Character.charCount(a)
        second += Character.charCount(b)
    }
    return (left.length - first).compareTo(right.length - second)
}

// Port of limit_left
fun limitLeft(row: Thread, nowMs: Long = System.currentTimeMillis()): Long {
    val reset = row.limitResetsAtMs
    if (reset <= nowMs) return 0
    // Split seconds and remainders so the millisecond difference cannot overflow.
    val seconds = Math.floorDiv(reset, 1000L) - Math.floorDiv(nowMs, 1000L)
    return seconds + if (Math.floorMod(reset, 1000L) > Math.floorMod(nowMs, 1000L)) 1 else 0
}

// Port of clock_interval
fun clockInterval(rows: List<Thread>, nowMs: Long = System.currentTimeMillis()): Long =
    if (rows.any { it.state == "working" && !it.archived || limitLeft(it, nowMs) in 1L..3600L }) 2 else 60

// Port of attention_indicator
fun attentionIndicator(row: Thread, drawer: Boolean = false, nowMs: Long = System.currentTimeMillis()): String = when {
    row.actionRequired || row.questionAttention -> "question"
    row.unread || (drawer && row.drawer && row.state != "working" && limitLeft(row, nowMs) == 0L) -> "dot"
    row.state == "working" && row.discardResult -> "discard"
    row.state == "idle" && row.lastOutcome == "stopped" -> "stop"
    else -> ""
}

// Port of provider_query
fun providerQuery(query: String, app: String = "all"): Pair<String, String> {
    val match = providerPrefix.matchEntire(query)
    val selectedApp = if (match == null) app else
        if (match.groupValues[1].equals("cl", true) || match.groupValues[1].equals("claude", true))
            "claude-desktop-code" else "codex"
    return casefold((match?.groupValues?.get(2) ?: query).trim { pythonSpace.matches(it.toString()) }) to selectedApp
}

// Port of filtered_rows
fun filteredRows(threads: List<Thread>, f: Filter): List<Thread> {
    val (query, app) = providerQuery(f.query, f.app)
    val workingOrUnread = f.pendingOnly && f.states == setOf("working")
    fun bucket(row: Thread) = if (row.pending || row.state == "waiting") 0 else when (row.state) {
        "working" -> 1
        "idle" -> 2
        else -> 3
    }
    fun moment(row: Thread) = if (row.state == "working") row.workingSinceMs.coerceAtLeast(0) else row.updatedAtMs
    return threads.filter { row ->
        (f.archived || !row.archived) &&
            (!f.drawerOnly || row.drawer) &&
            (app == "all" || row.provider == app) &&
            (if (workingOrUnread) row.state == "working" || row.pending || row.unread || row.questionAttention
             else row.state in f.states && (!f.pendingOnly || row.pending)) &&
            (query.isEmpty() || query in casefold(listOf(
                row.title, row.projectName, row.cwd, row.providerLabel, row.sourceLabel,
            ).joinToString("\n")))
    }.sortedWith(
        compareBy<Thread> { !it.pinned }
            .thenBy { if (it.pinned) it.pinIndex else 0 }
            .thenBy { if (it.pinned) 0 else bucket(it) }
            .thenBy { !it.pinned && it.state != "working" }
            .thenByDescending { if (it.pinned) 0L else moment(it) }
            .thenComparator { left, right -> compareIds(left.id, right.id) },
    )
}

// Port of row_menu_actions
fun rowMenuActions(row: Thread): List<MenuAction> = buildList {
    val indicator = attentionIndicator(row)
    if (!row.actionRequired) add(
        if (row.drawer || indicator in setOf("question", "dot")) MenuAction("Read", "mark-read")
        else MenuAction("Unread", "mark-unread"),
    )
    if (row.drawer) add(MenuAction("Take out of drawer", "drawer-out"))
    else if (indicator == "dot") add(MenuAction("Put in drawer", "drawer-in"))
    add(if (row.pinned) MenuAction("Unpin", "unpin") else MenuAction("Pin", "pin"))
    if (row.pinned) {
        add(MenuAction("Move pin earlier", "pin-up"))
        add(MenuAction("Move pin later", "pin-down"))
    }
    if (row.state == "working") add(
        if (row.discardResult) MenuAction("Keep result", "keep-result") else MenuAction("Discard result", "discard-result"),
    )
}

// Port of pin_move_body
fun pinMoveBody(visibleRows: List<Thread>, id: String, direction: String): String? {
    val pins = visibleRows.filter { it.pinned }.map { it.id }
    val index = pins.indexOf(id)
    if (index < 0) return null
    val target = pins.getOrNull(index + if (direction == "up") -1 else 1) ?: return null
    return buildJsonObject {
        put("targetId", target)
        put("placement", if (direction == "up") "before" else "after")
    }.toString()
}

// Port of new_messages
fun newMessages(
    messages: List<Message>,
    seen: Set<Message>?,
    visible: Set<String>,
    nowMs: Long,
    room: Int,
): Pair<List<Message>, Set<Message>> {
    val play = mutableListOf<Message>()
    val pairs = mutableSetOf<Pair<String, String>>()
    val oldest = if (nowMs < Long.MIN_VALUE + MESSAGE_MAX_AGE_MS) Long.MIN_VALUE else nowMs - MESSAGE_MAX_AGE_MS
    for (message in messages) {
        if (seen == null || message in seen || message.atMs < oldest || message.from == message.to ||
            message.from !in visible || message.to !in visible || play.size >= room) continue
        if (!pairs.add(message.from to message.to)) continue
        play.add(message)
    }
    return play to messages.toSet()
}

// Port of message_duration
fun messageDuration(distance: Double): Double {
    val duration = distance / 1.5
    return if (duration > 480) minOf(900.0, duration) else 480.0
}

// Port of message_control
fun messageControl(start: Pair<Double, Double>, end: Pair<Double, Double>): Pair<Double, Double> {
    val dx = end.first - start.first
    val dy = end.second - start.second
    val distance = hypot(dx, dy)
    var x = (start.first + end.first) / 2
    var y = (start.second + end.second) / 2
    if (distance != 0.0) {
        val bow = if (.22 * distance < 60) .22 * distance else 60.0
        val nx = -dy / distance
        val ny = dx / distance
        val sign = if (if (abs(dx) >= abs(dy)) ny > 0 else nx > 0) -1 else 1
        x += sign * nx * bow
        y += sign * ny * bow
    }
    return (if (x > 2) x else 2.0) to y
}
