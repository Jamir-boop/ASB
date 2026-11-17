package local.asb.companion.ui

import androidx.compose.ui.graphics.Color
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.roundToInt
import local.asb.companion.R
import local.asb.companion.data.Message
import local.asb.companion.data.Palette
import local.asb.companion.data.Thread
import local.asb.companion.data.usageAppKey

internal fun appMark(app: String): Int = when (usageAppKey(app)) {
    "codex" -> R.drawable.ic_provider_openai
    "claude" -> R.drawable.ic_provider_claude
    "opencode" -> R.drawable.ic_provider_opencode
    "" -> R.drawable.ic_machine
    else -> R.drawable.ic_terminal
}

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
    "^$PYTHON_SPACE*(cl|claude|cx|codex|oc|opencode)$PYTHON_SPACE*:$PYTHON_SPACE*(.*)$",
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

// Port of clock_interval: a Working time updates each 30 s (the Working sign pulses between the updates).
// shortcut: times show whole minutes, but the clock still ticks every 2 s for a countdown under one hour, and a longer countdown
// can lag up to 60 s; port clock_wait (wake at the next whole minute) if battery or lag matters.
fun clockInterval(rows: List<Thread>, nowMs: Long = System.currentTimeMillis()): Long = when {
    rows.any { limitLeft(it, nowMs) in 1L..3600L } -> 2
    rows.any { it.state == "working" && !it.archived } -> WORKING_CLOCK_S
    else -> 60
}

const val WORKING_CLOCK_S = 30L
// The Working sign: a dot before the word Working, alpha 0.4 to 1.0 and back in 1.6 s.
const val WORKING_PULSE_MS = 1600

/** The Working sign alpha at [phase] (0 to 1 of one pulse); still at full alpha with Android animations off. */
fun workingSignAlpha(animationsOff: Boolean, phase: Float): Float =
    if (animationsOff) 1f else (.7 + .3 * kotlin.math.cos(2 * Math.PI * phase)).toFloat()

/** As the board card_title: the title with its spaces made one, or Untitled session. */
fun cardTitle(row: Thread): String =
    row.title.split(pythonSpace).filter { it.isNotEmpty() }.joinToString(" ").ifEmpty { "Untitled session" }

// Port of attention_indicator
fun attentionIndicator(row: Thread, drawer: Boolean = false, nowMs: Long = System.currentTimeMillis()): String = when {
    showsAction(row) || row.questionAttention || (drawer && row.drawer && row.state == "waiting") -> "question"
    row.alert -> "alert"
    row.unread || (drawer && row.drawer && row.state != "working" && limitLeft(row, nowMs) == 0L) -> "dot"
    row.state == "working" && row.discardResult -> "discard"
    row.state == "idle" && (row.lastOutcome == "stopped" || row.lastOutcome == "limit" && limitLeft(row, nowMs) == 0L) -> "stop"
    else -> ""
}

// The card mark: outside the drawer view a drawer row looks read, so a drawer permission wait keeps the passive "?" of a read
// permission wait (the desktop shows it with CSS).
fun cardIndicator(row: Thread, drawerView: Boolean, nowMs: Long = System.currentTimeMillis()): String =
    attentionIndicator(row, drawerView, nowMs).ifEmpty {
        if (!drawerView && row.drawer && row.state == "waiting" && row.actionRequired) "question" else ""
    }

// Port of provider_query
fun providerQuery(query: String, app: String = "all"): Pair<String, String> {
    val match = providerPrefix.matchEntire(query)
    val selectedApp = if (match == null) app else when (match.groupValues[1].lowercase()) {
        "cl", "claude" -> "claude-desktop-code"
        "oc", "opencode" -> "opencode"
        else -> "codex"
    }
    return casefold((match?.groupValues?.get(2) ?: query).trim { pythonSpace.matches(it.toString()) }) to selectedApp
}

val APP_FILTERS = listOf("all" to "All", "codex" to "Codex", "claude-desktop-code" to "Claude", "opencode" to "OpenCode")

fun providerIcon(provider: String): Int = when (provider) {
    "codex" -> R.drawable.ic_provider_openai
    "opencode" -> R.drawable.ic_provider_opencode
    else -> R.drawable.ic_provider_claude
}

// The one-column list shows this many rows at first and this many more for each Show more; the rows that need you sort first.
const val ROW_PAGE = 100

fun pageRows(rows: List<Thread>, shown: Int): List<Thread> = rows.take(shown)

// Port of filtered_rows
fun filteredRows(threads: List<Thread>, f: Filter): List<Thread> {
    val (query, app) = providerQuery(f.query, f.app)
    val workingOrUnread = f.pendingOnly && f.states == setOf("working")
    fun bucket(row: Thread) = if (row.pending) 0 else when (row.state) {
        "working" -> 1
        "idle", "waiting" -> 2
        else -> 3
    }
    // Pending sorts by the mark of this view: Working ?, other ?, !, dot, then the rest; Working rows lead other buckets.
    fun rank(row: Thread) = if (!row.pending) (if (row.state == "working") 0 else 1) else
        when (attentionIndicator(row, f.drawerOnly)) {
            "question" -> if (row.state == "working") 0 else 1
            "alert" -> 2
            "dot" -> 3
            else -> 4
        }
    fun moment(row: Thread) = if (row.state == "working") row.workingSinceMs.coerceAtLeast(0) else maxOf(row.updatedAtMs, row.mutedAtMs)
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
            .thenBy { if (it.pinned) 0 else rank(it) }
            .thenByDescending { if (it.pinned) 0L else moment(it) }
            .thenComparator { left, right -> compareIds(left.id, right.id) },
    )
}

/** The rows each top bar pill would show when it is on, without the search: Pending, Working, and Drawer. */
data class PillCounts(val pending: Int, val working: Int, val drawer: Int)

fun pillCounts(threads: List<Thread>, f: Filter): PillCounts {
    val base = f.copy(query = "")
    return PillCounts(
        filteredRows(threads, base.copy(pendingOnly = true, drawerOnly = false)).size,
        filteredRows(threads, base.copy(states = setOf("working"))).size,
        filteredRows(threads, base.copy(drawerOnly = true, pendingOnly = false)).size,
    )
}

fun pillLabel(label: String, count: Int): String = if (count > 0) "$label $count" else label

fun pillDescription(label: String, count: Int): String =
    if (count > 0) "$label, $count session${if (count == 1) "" else "s"}" else label

/** True when a filter other than the search is on. */
fun filtersOn(f: Filter): Boolean = f.copy(query = "") != Filter()

/** As the board filter_chips: one (key, name) per active filter, in top bar order. */
fun activeFilterChips(f: Filter): List<Pair<String, String>> = buildList {
    if (f.pendingOnly) add("pending" to "Pending")
    if (f.states != STATES.toSet()) STATES.filter { it in f.states }.forEach { add("state:$it" to stateLabel(it)) }
    if (f.drawerOnly) add("drawer" to "Drawer")
    if (f.app != "all") add("app" to (APP_FILTERS.firstOrNull { it.first == f.app }?.second ?: f.app))
    if (f.archived) add("archive" to "Include archived")
}

/** As the board clear_filter_chip: the filter without the chip [key]; a state filter with no state left shows all states. */
fun removeFilter(f: Filter, key: String): Filter = when {
    key == "pending" -> f.copy(pendingOnly = false)
    key.startsWith("state:") -> (f.states - key.removePrefix("state:")).let { f.copy(states = it.ifEmpty { STATES.toSet() }) }
    key == "drawer" -> f.copy(drawerOnly = false)
    key == "app" -> f.copy(app = "all")
    key == "archive" -> f.copy(archived = false)
    else -> f
}

/** True at the first Pending row after the pins, where the list shows its Pending header. */
fun pendingHeader(rows: List<Thread>, index: Int): Boolean {
    fun pendingRow(row: Thread) = row.pending && !row.pinned
    return pendingRow(rows[index]) && (index == 0 || !pendingRow(rows[index - 1]))
}

/** As the board Esc: Back clears an open search and the filters before it leaves the screen. */
fun backClears(searching: Boolean, f: Filter): Boolean = searching || f != Filter()

private val homePrefix = Regex("""^(/home/[^/]+|/Users/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=$|[/\\])""")

/** A PC folder with `~` for a usual home folder; the API sends no PC home, so this reads the path form. */
fun homePath(path: String): String = homePrefix.replaceFirst(path, "~")

/**
 * The folder path to show on a row that matches the search only by its folder path (as the board tooltip path), else "".
 * The other searched fields show on the card already.
 */
fun pathMatch(row: Thread, query: String): String {
    val (text, _) = providerQuery(query)
    if (text.isEmpty() || row.cwd.isEmpty() || text !in casefold(row.cwd)) return ""
    val shown = casefold(listOf(row.title, row.projectName, row.providerLabel, row.sourceLabel).joinToString("\n"))
    return if (text in shown) "" else homePath(row.cwd)
}

// A required action keeps its "?" mark after Read; an older engine sends no read mark, so the action stays unread.
fun actionNeedsAttention(row: Thread): Boolean = row.actionAttention ?: row.actionRequired

// Port of shows_action: on a muted or drawer row, a required action shows its "?" mark only for a request that came after the start
// of the mute or after the row went in the drawer.
fun showsAction(row: Thread): Boolean = row.actionRequired && (!(row.muted || row.drawer) || actionNeedsAttention(row))

// Port of drawer_offer: an unread dot or "!", or a row that waits for an answer.
// shortcut: an engine older than this app refuses a Waiting row with "The drawer takes only unread sessions."; the phone then
// shows that error. Check the engine version first if old engines stay common.
fun drawerOffer(row: Thread): Boolean = !row.drawer && attentionIndicator(row).let {
    it == "dot" || it == "alert" || (row.state == "waiting" && it == "question")
}

// Port of row_menu_actions
fun rowMenuActions(row: Thread): List<MenuAction> = buildList {
    val indicator = attentionIndicator(row)
    val unread = if (showsAction(row)) actionNeedsAttention(row) || row.unread else indicator in setOf("question", "alert", "dot")
    add(if (row.drawer || unread) MenuAction("Read", "mark-read") else MenuAction("Unread", "mark-unread"))
    add(if (row.pinned) MenuAction("Unpin", "unpin") else MenuAction("Pin", "pin"))
    if (row.drawer) add(MenuAction("Take out of drawer", "drawer-out"))
    else if (drawerOffer(row)) add(MenuAction("Put in drawer", "drawer-in"))
    if (row.pinned) {
        add(MenuAction("Move pin earlier", "pin-up"))
        add(MenuAction("Move pin later", "pin-down"))
    }
    // A session on another machine cannot be discarded from here.
    if (row.state == "working" && !row.remote) add(
        if (row.discardResult) MenuAction("Leave unread when done", "keep-result") else MenuAction("Mark read when done", "discard-result"),
    )
}

// Port of is_view_only
fun isViewOnly(row: Thread): Boolean = row.remote || row.surface == "cli"

// Port of row_where: the glyph and the text that say where a view-only session runs.
fun rowWhere(row: Thread): Pair<Int?, String> = when {
    row.remote -> R.drawable.ic_machine to row.machineName.ifEmpty { "another machine" }
    row.surface == "cli" -> R.drawable.ic_terminal to "CLI"
    else -> null to ""
}

/** The card glyphs and counts of running background work, commands first; empty when there is none or the option is off. */
fun backgroundCounts(row: Thread, shown: Boolean = true): List<Pair<Int, Int>> = if (!shown) emptyList() else listOfNotNull(
    (R.drawable.ic_bg_command to row.backgroundCommands).takeIf { it.second > 0 },
    (R.drawable.ic_bg_agent to row.backgroundAgents).takeIf { it.second > 0 },
)

/** As the board, in dp: the gap after the state, between the kinds, and from glyph to count (Compact 10, 8, 3). */
fun backgroundGaps(comfortable: Boolean): Triple<Int, Int, Int> = if (comfortable) Triple(12, 10, 4) else Triple(10, 8, 3)

/** As the board: "1 command, 2 agents in the background", only the kinds above 0; empty when there is none or the option is off. */
fun backgroundSentence(row: Thread, shown: Boolean = true): String {
    if (!shown) return ""
    fun count(value: Int, noun: String) = if (value > 0) "$value $noun${if (value == 1) "" else "s"}" else ""
    val parts = listOf(count(row.backgroundCommands, "command"), count(row.backgroundAgents, "agent")).filter { it.isNotEmpty() }
    return if (parts.isEmpty()) "" else parts.joinToString(", ") + " in the background"
}

// Port of view_only_tone
fun viewOnlyTone(row: Thread): String = when {
    !isViewOnly(row) || row.unread || row.questionAttention || row.pending || row.limitResetsAtMs > 0 -> ""
    row.state == "working" -> "quiet"
    else -> "rest"
}

/** One row panel control: its state, and the action a change runs, or null when the change is not offered. */
data class PanelControl(val on: Boolean, val action: String?)

// Port of row_panel_controls: the row panel switches from rowMenuActions, in panel order.
fun rowPanelControls(row: Thread): Map<String, PanelControl> {
    val offered = rowMenuActions(row).map { it.action }.toSet()
    fun pick(vararg names: String) = names.firstOrNull { it in offered }
    return buildMap {
        put("unread", PanelControl("mark-unread" !in offered, pick("mark-read", "mark-unread")))
        put("pinned", PanelControl("unpin" in offered, pick("unpin", "pin")))
        put("drawer", PanelControl("drawer-out" in offered, pick("drawer-out", "drawer-in")))
        if ("pin-up" in offered) put("order", PanelControl(true, "pin-up"))
        if ("discard-result" in offered || "keep-result" in offered) {
            put("discard", PanelControl("keep-result" in offered, pick("keep-result", "discard-result")))
        }
    }
}

// Port of the restore_panel_focus check: the panel control that gets the focus back when its action ends, if it is
// still there and enabled. The Earlier and Later buttons belong to the "order" control.
fun panelFocusReturn(key: String?, controls: Map<String, PanelControl>): String? = when (key) {
    null -> null
    "earlier", "later" -> key.takeIf { "order" in controls }
    // Mute and Unmute always show; a mute time goes back to the Unmute row, and Unmute to the first time.
    "mute" -> key
    else -> if (key.startsWith("mute:")) "mute" else key.takeIf { controls[key]?.action != null }
}

// Port of row_panel_note: the subtitle of the panel Unread switch.
fun rowPanelNote(row: Thread): String = when {
    row.actionRequired -> "Waits for your permission."
    row.questionAttention || row.drawer && row.state == "waiting" -> "Asks a question."
    row.alert -> if (row.processEnded) "The Claude Code process ended during a task. Not read yet."
        else if (row.lastOutcome == "failed") "Failed. Not read yet." else "Usage limit stopped the task. Not read yet."
    (row.unread || row.drawer) && row.state != "working" -> if (row.manualUnread) "Marked unread." else "Finished. Not read yet."
    else -> ""
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

const val DEFAULT_COLUMN_WIDTH = 240
// Touch row heights in dp: 48 dp is the Android touch minimum, so Compact is higher than the desktop 22 px.
const val COMPACT_ROW_HEIGHT = 48
// Comfortable cards have no hover highlight on touch, so a gap shows which footer belongs to which card.
// It is the portrait gap and the largest Column Flow gap; Column Flow can go down to the minimum gap.
const val COMFORTABLE_CARD_GAP = 24
const val COMFORTABLE_MIN_CARD_GAP = 8
// The Comfortable card parts: dp sizes, and sp line heights that grow with the card font scale.
const val COMFORTABLE_PADDING = 2
const val COMFORTABLE_SPACING = 2
const val CAPTION_LINE_HEIGHT = 14
const val TITLE_LINE_HEIGHT = 16
// The Comfortable title takes 1 or 2 lines and the state line follows it; the card height keeps room for 2.
const val COMFORTABLE_TITLE_LINES = 2
const val COMFORTABLE_TITLE_MIN_LINES = 1
const val PROVIDER_MARK_SIZE = 14
const val LIMIT_CLOCK_SIZE = 12

/** The font scale of the session cards: the phone font scale, times the Card text size setting, times the zoom percent. */
fun cardFontScale(phoneFontScale: Float, cardTextScale: Float, zoom: Int = 100): Float =
    phoneFontScale * cardTextScale * zoom / 100f

// The card zoom levels in percent, as the board ZOOM_LEVELS.
val ZOOM_LEVELS = listOf(80, 90, 100, 110, 125, 150, 175, 200)
const val PINCH_STEP = 1.15f

/** A saved zoom percent, or 100 when it is not a level. */
fun zoomLevel(zoom: Int): Int = if (zoom in ZOOM_LEVELS) zoom else 100

/** The zoom level [steps] levels above (positive) or below [zoom], within ZOOM_LEVELS, as the board zoom_step. */
fun zoomStep(zoom: Int, steps: Int): Int =
    ZOOM_LEVELS[(ZOOM_LEVELS.indexOf(zoomLevel(zoom)) + steps).coerceIn(0, ZOOM_LEVELS.lastIndex)]

/** (steps, factor): the pinch factor since the last step, times [change]; one level for each PINCH_STEP. */
fun pinchStep(factor: Float, change: Float): Pair<Int, Float> {
    // Two fingers on one point give a zero or infinite change; it would never leave the loops below.
    if (!(change > 0f) || change.isInfinite()) return 0 to factor
    var rest = factor * change
    var steps = 0
    while (rest >= PINCH_STEP) { rest /= PINCH_STEP; steps++ }
    while (rest <= 1 / PINCH_STEP) { rest *= PINCH_STEP; steps-- }
    return steps to rest
}

fun zoomBadgeText(zoom: Int): String = "$zoom%"
fun zoomBadgeDescription(zoom: Int): String = "Zoom $zoom%. Reset zoom."

/** The Comfortable card height in dp: workspace line, two title lines, and footer, at this font scale. */
fun comfortableCardHeight(fontScale: Float): Float =
    2 * COMFORTABLE_PADDING + 2 * COMFORTABLE_SPACING +
        maxOf(PROVIDER_MARK_SIZE.toFloat(), CAPTION_LINE_HEIGHT * fontScale) +
        COMFORTABLE_TITLE_LINES * TITLE_LINE_HEIGHT * fontScale +
        maxOf(LIMIT_CLOCK_SIZE.toFloat(), CAPTION_LINE_HEIGHT * fontScale)

/** The Compact row height in dp: the touch minimum, or the title line when the text is larger. */
fun compactRowHeight(fontScale: Float): Float = maxOf(COMPACT_ROW_HEIGHT.toFloat(), TITLE_LINE_HEIGHT * fontScale)

data class Packing<T>(val columns: Int, val capacity: Int, val parts: List<List<T>>, val gap: Float = 0f)

// Port of pack_columns. Whole rows with at least minGap between them fit in height - 4; the rest of the
// height spreads as the gap, up to maxGap. The column has capacity - 1 gaps.
fun <T> packColumns(
    rows: List<T>, width: Int, height: Int, columnWidth: Int = DEFAULT_COLUMN_WIDTH, rowHeight: Float,
    minGap: Float = 0f, maxGap: Float = 0f,
): Packing<T> {
    val room = height - 4
    val capacity = maxOf(1, ((room + minGap) / (rowHeight + minGap)).toInt())
    val gap = if (capacity > 1) minOf(maxGap, (room - capacity * rowHeight) / (capacity - 1)) else 0f
    return Packing(maxOf(1, Math.floorDiv(width + 12, columnWidth + 12)), capacity, rows.chunked(capacity), gap)
}

/**
 * A lazy list follows the key of its first visible item when the data changes. The desktop keeps the scroll offset,
 * so the list keeps its position by index when its keys change. Not on the first composition, and not while the user
 * scrolls (a new position would stop the fling).
 */
fun keepIndexOnChange(previousKeys: List<Any>?, keys: List<Any>, scrolling: Boolean): Boolean =
    previousKeys != null && !scrolling && previousKeys != keys

/**
 * The first visible index and scroll offset after the items before the first row ([oldLead] before, [newLead] after)
 * change. A list at the top stays at the top, so a new warning shows. A row first keeps its row slot and offset. A
 * leading item first that is still a leading item ([keptIndex] is its new index, or -1 when it is gone) keeps its
 * offset at that index. Else the item now at its index, at most the first row, shows in full.
 */
fun keptPosition(firstIndex: Int, offset: Int, oldLead: Int, newLead: Int, keptIndex: Int): Pair<Int, Int> = when {
    firstIndex == 0 && offset == 0 -> 0 to 0
    firstIndex >= oldLead -> firstIndex - oldLead + newLead to offset
    keptIndex in 0 until newLead -> keptIndex to offset
    else -> minOf(firstIndex, newLead) to 0
}

/**
 * The first index of a new list state: the item of the row at [anchorIndex] (-1 for a list at the top or a missing
 * anchor, which starts at the top). The packed columns hold [capacity] rows each; the one-column list has [lead]
 * items before its first row.
 */
fun startIndex(anchorIndex: Int, flow: Boolean, capacity: Int, lead: Int): Int = when {
    anchorIndex < 0 -> 0
    flow -> anchorIndex / capacity
    else -> lead + anchorIndex
}

/** The quiet read rule of the Comfortable view (the `.asb-idle-read` CSS); Unknown is quiet only with no mark. */
fun quietRow(row: Thread, comfortable: Boolean, drawerView: Boolean, nowMs: Long = System.currentTimeMillis()): Boolean =
    comfortable && (row.state == "idle" || row.state == "waiting" ||
        row.state == "unknown" && attentionIndicator(row, drawerView, nowMs).isEmpty()) &&
        !(row.unread || row.questionAttention || row.pending) &&
        limitLeft(row, nowMs) == 0L && !(drawerView && row.drawer)

data class CardTones(val title: String, val caption: String, val state: String)

/** Text colors of a card as palette hex values, as update_session_row, update_row_text, and set_palette give them. */
fun cardTones(
    palette: Palette, row: Thread, comfortable: Boolean, drawerView: Boolean, pressed: Boolean,
    nowMs: Long = System.currentTimeMillis(),
): CardTones {
    if (limitLeft(row, nowMs) > 0) {
        val limited = if (pressed) palette.limitedPressed else palette.limited
        return CardTones(limited, limited, limited)
    }
    if (!pressed && quietRow(row, comfortable, drawerView, nowMs)) {
        return CardTones(palette.quietTitle, palette.quietCaption, palette.quietCaption)
    }
    val state = when {
        row.state == "working" -> palette.success
        row.pending -> palette.text
        else -> palette.muted
    }
    // The Grey tone of a view-only card with no attention; Working keeps its state color.
    if (!pressed && !(drawerView && row.drawer)) when (viewOnlyTone(row)) {
        "quiet" -> return CardTones(palette.quietTitle, palette.quietCaption, state)
        "rest" -> return CardTones(palette.quietTitle, palette.quietCaption, palette.quietCaption)
    }
    return CardTones(palette.text, palette.muted, state)
}

/** One Comfortable corner control. A null action is a passive mark. */
data class CornerControl(val kind: String, val action: String?, val label: String)

/**
 * The Comfortable corner without hover, in visual order (drawer, read, pin): the Read target while attention shows,
 * the pin control while pinned, the filled drawer glyph for a drawer row, and the armed Discard ring.
 */
fun cornerControls(
    row: Thread, drawerView: Boolean, confirmed: Boolean, nowMs: Long = System.currentTimeMillis(),
): List<CornerControl> = buildList {
    val indicator = cardIndicator(row, drawerView, nowMs)
    val discard = row.state == "working" && indicator !in setOf("question", "alert", "dot")
    if (row.drawer) add(CornerControl("drawer", "drawer-out",
        if (row.state == "waiting") "Take out of drawer: show as waiting again" else "Take out of drawer: show as unread again"))
    when {
        discard && row.discardResult -> add(CornerControl("discard", "keep-result", "Leave unread when done: the dot shows when this task ends"))
        discard -> Unit
        confirmed -> add(CornerControl("confirmed", null, "Read in ASB"))
        showsAction(row) && (actionNeedsAttention(row) || row.unread) ->
            add(CornerControl("question", "mark-read", "A user action is required in the original app. Mark read in ASB"))
        showsAction(row) || row.drawer && !drawerView && indicator == "question" ->
            add(CornerControl("question", null, "A user action is required in the original app"))
        indicator == "question" -> add(CornerControl("question", "mark-read", "Mark read in ASB"))
        indicator == "alert" -> add(CornerControl("alert", "mark-read", "Mark read in ASB"))
        indicator == "dot" -> add(CornerControl("dot", "mark-read", "Mark read in ASB"))
        indicator == "stop" -> add(CornerControl("stop", null, "Task stopped"))
    }
    if (row.pinned) add(CornerControl("pin", "unpin", "Unpin in ASB"))
}

/** True when an alert ("!" mark) is a usage limit stop, as indicatorMeaning reads it; else a failure or a process end. */
fun alertIsLimit(row: Thread): Boolean = !row.processEnded && row.lastOutcome != "failed"

/** The meaning of a Pending corner mark for TalkBack, not its glyph; "" for the other corner controls. */
fun cornerMeaning(row: Thread, control: CornerControl): String = when (control.kind) {
    "question" -> if (showsAction(row) || control.action == null) "Waiting for approval" else "Needs your answer"
    "alert" -> if (alertIsLimit(row)) "Usage limit" else if (row.processEnded) "Process ended" else "Failed"
    "dot" -> when {
        row.failedAttention -> if (row.processEnded) "Process ended" else "Failed"
        row.completionAttention -> "Done, unread"
        else -> "Unread"
    }
    else -> ""
}

/** The words of a corner control: its meaning, its action, and the session title. */
fun cornerDescription(row: Thread, control: CornerControl): String =
    cornerMeaning(row, control).let { if (it.isEmpty()) "" else "$it. " } + "${control.label}: ${cardTitle(row)}"

// Each corner control has a 48 dp touch target of its own; the controls never overlap.
const val CORNER_TARGET = 48

/**
 * The corner slots from left to right, so the read and pin slots keep their places as on the desktop: the pin is at the end,
 * the read mark left of it, the drawer left of that. A slot at the end with no control is null; no control gives no slot.
 */
fun cornerSlots(controls: List<CornerControl>): List<CornerControl?> {
    val pin = controls.firstOrNull { it.kind == "pin" }
    val read = controls.firstOrNull { it.kind !in setOf("drawer", "pin") }
    val drawer = controls.firstOrNull { it.kind == "drawer" }
    val slots = listOf(pin, read, drawer)
    val used = slots.indexOfLast { it != null } + 1
    return slots.take(used).reversed()
}

/** The width in dp that the title and folder lines leave free for the corner controls. */
fun cornerReserve(slots: List<CornerControl?>): Int = slots.size * CORNER_TARGET

/** The machine that opens a row: its own machine name, else the paired PC. */
fun openMachine(row: Thread, serverName: String): String =
    row.machineName.ifEmpty { serverName.ifEmpty { "the PC" } }

/** The first line of the inspector Open button; the app is the second line. */
fun openLabel(row: Thread, serverName: String): String = "Open on ${openMachine(row, serverName)}"

/** Why the inspector Open button is dimmed, else "" (the same words as the tap on the card). */
fun openReason(row: Thread): String = when {
    row.canOpen -> ""
    row.remote -> "Open it on ${row.machineName.ifEmpty { "another machine" }}."
    row.surface == "cli" -> "ASB does not open CLI sessions."
    else -> "This session has no direct link."
}

/** Why a row panel switch is dimmed, else "". Only the drawer switch can have no action. */
fun panelReason(row: Thread, key: String, controls: Map<String, PanelControl>): String = when {
    controls[key]?.action != null -> ""
    key == "drawer" && row.state == "working" -> "A Working session cannot go in the drawer."
    key == "drawer" -> "Only an unread or waiting session can go in the drawer."
    else -> ""
}

/** The Compact question or alert glyph: disc diameter in dp, type size in sp, and glyph color. */
data class CompactMarkStyle(val discSize: Int, val fontSize: Int, val color: String)

// The Comfortable corner rule: an active ? or ! is an accent disc; a read permission wait is a bare quiet glyph.
fun compactMarkStyle(row: Thread, palette: Palette, drawerView: Boolean, nowMs: Long): CompactMarkStyle {
    val active = cornerControls(row, drawerView, false, nowMs).any { it.kind in setOf("question", "alert") && it.action != null }
    return if (active) CompactMarkStyle(12, 9, palette.background) else CompactMarkStyle(0, 11, palette.quietCaption)
}

/** The plain centered place in a free space of px, rounded as `Alignment.Center` rounds it. */
fun plainCenteredPlace(space: Int): Int = (space / 2f).roundToInt()

/**
 * The whole-pixel top-left of a one-glyph text in a box, so that its ink (not its line box) is centered:
 * the plain centered place, moved by the offset of the ink center from the text layout center. All values are px.
 */
fun inkCenteredPlace(
    boxWidth: Int, boxHeight: Int, textWidth: Int, textHeight: Int,
    inkLeft: Float, inkTop: Float, inkRight: Float, inkBottom: Float,
): Pair<Int, Int> {
    // Round half up (a half pixel goes right or down), so a .5 never depends on the float rounding mode.
    fun place(box: Int, text: Int, start: Float, end: Float) =
        floor((box - text) / 2f - ((start + end) / 2f - text / 2f) + .5f).toInt()
    return place(boxWidth, textWidth, inkLeft, inkRight) to place(boxHeight, textHeight, inkTop, inkBottom)
}

/** The provider mark tint: the message light, then the limit, then the quiet caption of a quiet card. */
fun providerMarkTint(palette: Palette, limited: Boolean, messageLit: Boolean, quiet: Boolean = false): Color = when {
    messageLit -> hexColor(palette.accent)
    limited -> hexColor(palette.text).copy(alpha = .4f)
    quiet -> hexColor(palette.quietCaption)
    else -> hexColor(palette.text).copy(alpha = .65f)
}

// The phone text of each dashboard referenceUnavailable code, as the board REFERENCE_REASONS; <machine> is the row's machineName.
private val REFERENCE_REASONS = mapOf(
    "no-machine-identity" to "The PC has no ASB machine ID. Run asb doctor on the PC.",
    "unknown-source" to "ASB does not know the profile of this session.",
    "invalid-app-id" to "This session has an ID in a form that ASB does not know.",
    "unsupported-type" to "This version of ASB does not know this app. Update ASB on the PC.",
    "old-peer" to "<machine> has an older ASB. Update ASB on that machine.",
    "ambiguous-source" to "More than one profile reads this session. ASB cannot pick one.",
)

/**
 * Port of the absolute part of copy_values: (the `asb:1/...` reference to copy, "") when it is one safe line, else
 * (null, the reason that the Copy reference button shows).
 */
fun copyReference(row: Thread): Pair<String?, String> {
    val full = row.reference
    // Printable ASCII with no space or line break; the engine checks the grammar.
    if (full.length in 1..384 && full.all { it in '!'..'~' }) return full to ""
    val code = row.referenceUnavailable
    val machine = row.machineName.ifEmpty { "The other machine" }
    return null to when {
        full.isEmpty() && code.isEmpty() -> "The ASB engine on the PC is older. Update ASB on the PC."
        code == "unknown-source" && row.remote -> "$machine did not send the profile of this session."
        code in REFERENCE_REASONS -> REFERENCE_REASONS.getValue(code).replace("<machine>", machine)
        else -> "ASB cannot make a full reference for this session."
    }
}

/** The board mute choices (MUTE_WORDS and MUTE_DURATIONS): the words and the duration in ms, null for Always. */
val MUTE_CHOICES: List<Pair<String, Long?>> = listOf(
    "30 min" to 1_800_000L, "1 hour" to 3_600_000L, "8 hours" to 28_800_000L, "1 day" to 86_400_000L, "Always" to null,
)

/** As the board MUTE_TIPS: what a mute choice does, for TalkBack. */
fun muteTip(words: String): String = when (words) {
    "30 min" -> "Mute for 30 minutes"
    "Always" -> "Mute until you unmute"
    else -> "Mute for $words"
}

/** Port of mute_body: the gateway `mute` body, `{"durationMs": N}`, or `{}` for Always. */
fun muteBody(durationMs: Long?): String =
    if (durationMs == null) "{}" else buildJsonObject { put("durationMs", durationMs) }.toString()

/** Port of mute_active: the row is muted, and a timed mute has not ended. */
fun muteActive(row: Thread, nowMs: Long = System.currentTimeMillis()): Boolean =
    row.muted && (row.mutedUntilMs <= 0 || nowMs < row.mutedUntilMs)

/** Port of mute_flag_text in 24 hours: `Muted until 14:30` (with the weekday when the end is not today), `Muted`, or "". */
fun muteFlagText(row: Thread, nowMs: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
    if (!muteActive(row, nowMs)) return ""
    if (row.mutedUntilMs <= 0) return "Muted"
    val end = Instant.ofEpochMilli(row.mutedUntilMs).atZone(zone)
    val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate() == end.toLocalDate()
    return "Muted until " + DateTimeFormatter.ofPattern(if (today) "HH:mm" else "EEEE HH:mm", Locale.US).format(end)
}
