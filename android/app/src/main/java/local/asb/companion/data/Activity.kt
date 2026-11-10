package local.asb.companion.data

import kotlin.math.atan2
import kotlin.math.cbrt
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonTransformingSerializer

// The Messages and Usage replies (activity contract 2.1 and 2.3) and their pure rules (contract 5).

@Serializable
data class ActivityBuckets(
    val unit: String = "day",
    val startsMs: List<@Serializable(with = MillisSerializer::class) Long> = emptyList(),
    // The hour of the first record; only the All time reply has it.
    @Serializable(with = MillisSerializer::class) val firstMs: Long? = null,
    // The end of the last bucket; an older engine has none.
    @Serializable(with = MillisSerializer::class) val endMs: Long? = null,
)

@Serializable
data class ActivityMachine(
    val machineId: String = "",
    val name: String = "",
    val self: Boolean = false,
    val state: String = "offline",
    @Serializable(with = MillisSerializer::class) val lastReportAtMs: Long = 0,
)

@Serializable
data class Seat(
    val id: String = "",
    val title: String = "",
    val app: String = "",
    val machineId: String = "",
    val order: Int = 0,
)

@Serializable
data class ActivityMessage(
    val id: String = "",
    val from: String = "",
    val to: String = "",
    @Serializable(with = MillisSerializer::class) val atMs: Long = 0,
    val status: String = "unknown",
    val reason: String = "",
    val local: Boolean = false,
    /** The session names of an unknown end (`unknown:<machine>`), from the message. */
    val fromLabel: String = "",
    val toLabel: String = "",
)

@Serializable
data class ActivityMessages(
    val period: String = "7d",
    @Serializable(with = MillisSerializer::class) val nowMs: Long = 0,
    val machines: List<ActivityMachine> = emptyList(),
    val seats: List<Seat> = emptyList(),
    val messages: List<ActivityMessage> = emptyList(),
    val truncated: Boolean = false,
    val buckets: ActivityBuckets = ActivityBuckets(),
)

@Serializable
data class TokenParts(val uncached: Long = 0, val cacheRead: Long = 0, val cacheWrite: Long = 0, val output: Long = 0) {
    val processed: Long get() = uncached + cacheRead + cacheWrite + output
}

@Serializable
data class CostParts(
    val uncached: Double = 0.0,
    val cacheRead: Double = 0.0,
    val cacheWrite: Double = 0.0,
    val output: Double = 0.0,
    val total: Double = 0.0,
    val savings: Double = 0.0,
)

@Serializable
data class UsageRecord(
    val machineId: String = "",
    val app: String = "",
    val model: String = "",
    @Serializable(with = MakerSerializer::class) val maker: String = "",
    val bucket: Int = 0,
    val tokens: TokenParts = TokenParts(),
    val cost: CostParts? = null,
)

private object MakerSerializer : JsonTransformingSerializer<String>(String.serializer()) {
    override fun transformDeserialize(element: JsonElement): JsonElement =
        if (element is JsonPrimitive && element.isString) element else JsonPrimitive("")
}

/** The LiteLLM price list of the engine: [status] loading, fresh, cached, or unavailable. */
@Serializable
data class UsagePrices(
    val source: String = "",
    val status: String = "",
    @Serializable(with = MillisSerializer::class) val fetchedAtMs: Long? = null,
    val models: Int = 0,
)

@Serializable
data class UsageScan(val complete: Boolean = true, val files: Int = 0, val scannedFiles: Int = 0)

@Serializable
data class ActivityUsage(
    val period: String = "30d",
    @Serializable(with = MillisSerializer::class) val nowMs: Long = 0,
    val buckets: ActivityBuckets = ActivityBuckets(),
    val machines: List<ActivityMachine> = emptyList(),
    val records: List<UsageRecord> = emptyList(),
    val prices: UsagePrices = UsagePrices(),
    val scan: UsageScan = UsageScan(),
    // An older engine has no sessions part; the screen then shows no Sessions section.
    val sessions: UsageSessions? = null,
)

/** One session of the reply: its tokens, its priced cost, and [unpriced] when a model of it has no price. */
@Serializable
data class UsageSession(
    val machineId: String = "",
    val id: String = "",
    val app: String = "",
    val title: String = "",
    val tokens: TokenParts = TokenParts(),
    val cost: Double = 0.0,
    val unpriced: Boolean = false,
)

/** The usage of a machine that no session holds. */
@Serializable
data class UsageNone(val tokens: TokenParts = TokenParts(), val cost: Double = 0.0)

/** The sessions part of the Usage reply: the top sessions of each machine, the session count, and the usage with no session. */
@Serializable
data class UsageSessions(
    val rows: List<UsageSession> = emptyList(),
    val counts: Map<String, Int> = emptyMap(),
    val none: Map<String, UsageNone> = emptyMap(),
)

val MESSAGE_PERIODS = listOf("24h", "7d", "30d")
val USAGE_PERIODS = listOf("24h", "7d", "30d", "90d", "all")
const val SEAT_LIMIT = 12
const val ARRIVAL_WINDOW_MS = 120_000L

/** The apps in matrix and chart order; "" is Other. */
val APP_ORDER = listOf("codex", "claude", "opencode")
val USAGE_APP_ORDER = APP_ORDER + listOf("antigravity", "grok", "pi")
val STATUS_ORDER = listOf("accepted", "written", "held", "not-sent", "unknown")

val MACHINE_HUES = listOf("#b692c3", "#7cc48a", "#00898a", "#d6a15e", "#e38fb0", "#b4b86c")
val APP_COLORS = mapOf("codex" to "#c9ccd1", "claude" to "#d97757", "opencode" to "#7d848c",
    "antigravity" to "#4f8fe0", "grok" to "#e8e46a", "pi" to "#c678dd", "" to "#5d6268")
val STATUS_COLORS = mapOf("accepted" to "#c9ccd1", "written" to "#8c929a", "held" to "#e0b45a",
    "not-sent" to "#f5a090", "unknown" to "#5d6268")
val TOKEN_TYPES = listOf("cacheRead" to "Cache read", "cacheWrite" to "Cache write", "uncached" to "Uncached input", "output" to "Output")

/** The status meanings (PC MESSAGE_STATUS_TIPS); Not sent ends before the thread, which the phone does not have. */
val STATUS_TIPS = mapOf(
    "accepted" to "The receiving session took the message.",
    "written" to "ASB wrote the message to the receiver. No receipt came back.",
    "held" to "The receiver holds the message until its receive setting accepts it.",
    "not-sent" to "ASB did not send the message.",
    "unknown" to "The message can have gone out, but ASB has no proof.",
)

/** Port of chord_gray: the weakest mix of text into the background, from 40%, with 3:1 on the background and every fill. */
fun chordGray(background: String, text: String, fills: List<String>): String {
    for (percent in 40..100) {
        val value = mixColor(background, text, percent / 100.0)
        if ((listOf(background) + fills).all { contrast(value, it) >= 3 }) return value
    }
    return text
}

fun periodLabel(period: String): String = when (period) {
    "24h" -> "24 hours"
    "7d" -> "7 days"
    "30d" -> "30 days"
    "90d" -> "90 days"
    "all" -> "All time"
    else -> period
}

/** The short label of a Usage period button: 24h, 7d, 30d, 90d, All. */
fun periodShortLabel(period: String): String = if (period == "all") "All" else period

fun appLabel(app: String): String = when (app) {
    "codex" -> "Codex"
    "claude" -> "Claude Code"
    "opencode" -> "OpenCode"
    "antigravity" -> "Antigravity"
    "grok" -> "Grok"
    "pi" -> "Pi"
    else -> "Other"
}

/** An app outside the three known ones counts as Other (""). */
fun appKey(app: String): String = if (app in APP_ORDER) app else ""

fun usageAppKey(app: String): String = if (app in USAGE_APP_ORDER) app else ""

fun statusLabel(status: String): String = when (status) {
    "accepted" -> "Accepted"
    "written" -> "No receipt"
    "held" -> "On hold"
    "not-sent" -> "Not sent"
    else -> "Status unknown"
}

fun statusKey(status: String): String = if (status in STATUS_ORDER) status else "unknown"

/**
 * Port of message_failure_reason: with a known name of the receiver machine (the machineId of the `to` seat, or the ID after
 * `unknown:`), Machine offline becomes `Desk was not reachable` and Refused becomes `Refused by Desk`; else the reason stays.
 */
fun messageFailureReason(message: ActivityMessage, seats: Map<String, Seat> = emptyMap(), machines: List<ActivityMachine> = emptyList()): String {
    val machineId = seats[message.to]?.machineId?.takeIf { it.isNotEmpty() } ?: message.to.removePrefix("unknown:").takeIf { message.to.startsWith("unknown:") }
    val name = machines.firstOrNull { it.machineId == machineId }?.name?.takeIf { it.isNotEmpty() } ?: return message.reason
    return when (message.reason) {
        "Machine offline" -> "$name was not reachable"
        "Refused" -> "Refused by $name"
        else -> message.reason
    }
}

/** Port of message_status_label: the status name; a not-sent message adds its reason (Not sent · Desk was not reachable). */
fun messageStatusLabel(message: ActivityMessage, seats: Map<String, Seat> = emptyMap(), machines: List<ActivityMachine> = emptyList()): String =
    if (statusKey(message.status) == "not-sent" && message.reason.isNotEmpty()) "Not sent · ${messageFailureReason(message, seats, machines)}"
    else statusLabel(message.status)

/**
 * Port of message_bucket_partial: the last bucket holds nowMs (the current hour or day, which is not complete). Its end is
 * [ActivityBuckets.endMs], or without it an hour or a day after its start.
 */
fun messageBucketPartial(reply: ActivityMessages): Boolean {
    val last = reply.buckets.startsMs.lastOrNull() ?: return false
    val end = reply.buckets.endMs ?: (last + if (reply.buckets.unit == "hour") 3_600_000L else 86_400_000L)
    return reply.nowMs in last until end
}

/** Port of offline_band_color: the offline machine band, the [hue] mixed 55% toward [win], or less, as far as keeps 3:1 on [win]. */
fun offlineBandColor(win: String, hue: String): String =
    (45..100).map { mixColor(win, hue, it / 100.0) }.firstOrNull { contrast(it, win) >= 3 } ?: hue

/**
 * Port of offline_ring_color: the rest ring of an offline pin, the full machine [hue] moved toward [text] until it has 3:1 on the
 * sector tint of its machine (the hue 3% into [win]).
 */
fun offlineRingColor(win: String, text: String, hue: String): String = contrastFloor(hue, text, mixColor(win, hue, .03), 3.0)

/**
 * Port of thread_counts for a time thread: the messages of each chord in [chords] (by its key) in count strip bucket [index]
 * (from its start to the next start, or to [ActivityBuckets.endMs], or an hour or a day after its start for the last bucket).
 */
fun bucketPairCounts(reply: ActivityMessages, index: Int, chords: List<Chord>): Map<String, Int> {
    val starts = reply.buckets.startsMs
    val start = starts.getOrNull(index) ?: return emptyMap()
    val end = starts.getOrNull(index + 1) ?: reply.buckets.endMs ?: (start + if (reply.buckets.unit == "hour") 3_600_000L else 86_400_000L)
    val keys = chords.associate { setOf(it.a, it.b) to it.key }
    val counts = chords.associate { it.key to 0 }.toMutableMap()
    for (m in reply.messages) {
        if (m.atMs !in start until end) continue
        val key = keys[setOf(m.from, m.to)] ?: continue
        counts[key] = counts.getValue(key) + 1
    }
    return counts
}

/** One count strip bucket: its start, its messages, and its not-sent messages. */
data class BucketCount(val startMs: Long, val count: Int, val bad: Int)

/**
 * Port of message_buckets: a message goes in the last bucket whose start is at or before its time, so the local starts of the reply
 * decide each bucket; a message before the first start counts in none.
 */
fun messageBuckets(reply: ActivityMessages): List<BucketCount> {
    val starts = reply.buckets.startsMs
    val counts = IntArray(starts.size)
    val bad = IntArray(starts.size)
    for (m in reply.messages) {
        // binarySearch gives the index of an equal start, else -(insertion point) - 1.
        val found = starts.binarySearch(m.atMs)
        val index = if (found >= 0) starts.lastIndexOf(m.atMs) else -found - 2
        if (index < 0) continue
        counts[index]++
        if (statusKey(m.status) == "not-sent") bad[index]++
    }
    return starts.mapIndexed { i, start -> BucketCount(start, counts[i], bad[i]) }
}

/** The hue of the machine at [index] in machine order; the list repeats. */
fun machineHue(index: Int): String = MACHINE_HUES[index.coerceAtLeast(0) % MACHINE_HUES.size]

// ---------- Messages ----------

const val UNLISTED = "Unlisted sessions"

/** Port of unlisted_name: the name of a seat of sessions that are not cards: its one label, the count of its labels, or Unlisted sessions. */
fun unlistedName(labels: List<String>): String = when (labels.size) {
    0 -> UNLISTED
    1 -> labels[0]
    else -> "${labels.size} unlisted sessions"
}

/**
 * The name of each seat: an `unknown:` seat is named from the fromLabel and toLabel of its messages ([unlistedName]); another
 * seat by its title, or Unlisted sessions.
 */
fun seatTitles(reply: ActivityMessages): Map<String, String> = reply.seats.associate { seat ->
    seat.id to if (seat.id.startsWith("unknown:")) {
        unlistedName(reply.messages.flatMap { m -> listOf(m.from to m.fromLabel, m.to to m.toLabel) }
            .filter { it.first == seat.id && it.second.isNotEmpty() }.map { it.second }.distinct())
    } else seat.title.ifEmpty { UNLISTED }
}

/** One Busiest pairs row: [a] first on the circle, [n] messages both ways, [bad] not sent, [last] the newest message time. */
data class BusyPair(val a: String, val b: String, val n: Int, val bad: Int, val last: Long) {
    val key: String get() = "$a|$b"
}

/**
 * Port of messages_view busiest: the 5 pairs with the most messages (both directions, seated or not, a session to itself not
 * counted), high to low; a tie goes to the newer newest message, then to circle order.
 */
fun busiestPairs(reply: ActivityMessages, limit: Int = 5): List<BusyPair> {
    val position = circleOrder(reply).mapIndexed { i, seat -> seat.id to i }.toMap()
    val rank = { id: String -> position[id] ?: position.size }
    val pairs = LinkedHashMap<Pair<String, String>, BusyPair>()
    for (m in reply.messages) {
        if (m.from == m.to) continue
        val (a, b) = listOf(m.from, m.to).sortedWith(compareBy({ rank(it) }, { it })).let { it[0] to it[1] }
        val old = pairs[a to b] ?: BusyPair(a, b, 0, 0, m.atMs)
        pairs[a to b] = old.copy(n = old.n + 1, bad = old.bad + if (statusKey(m.status) == "not-sent") 1 else 0, last = max(old.last, m.atMs))
    }
    return pairs.values.sortedWith(compareBy({ -it.n }, { -it.last }, { rank(it.a) }, { rank(it.b) })).take(limit)
}

/** Seats in circle order: machines in reply order, then seat `order`; a seat of an unlisted machine goes last. */
fun circleOrder(reply: ActivityMessages): List<Seat> {
    val machineIndex = reply.machines.mapIndexed { index, machine -> machine.machineId to index }.toMap()
    return reply.seats.withIndex().sortedWith(compareBy<IndexedValue<Seat>>(
        { machineIndex[it.value.machineId] ?: Int.MAX_VALUE }, { it.value.order }, { it.index })).map { it.value }
}

/** The activity time of each seat: its newest message (sent or received, any status). */
fun activityTimes(messages: List<ActivityMessage>): Map<String, Long> {
    val times = HashMap<String, Long>()
    for (message in messages) for (id in listOf(message.from, message.to)) {
        if ((times[id] ?: Long.MIN_VALUE) < message.atMs) times[id] = message.atMs
    }
    return times
}

/** The seats with a message in the period, in circle order. */
fun activeSeats(reply: ActivityMessages): List<Seat> {
    val times = activityTimes(reply.messages)
    return circleOrder(reply).filter { it.id in times }
}

/** The seated set in circle order: [selected] (when it has a seat) plus the most recent others, up to [limit]. */
fun seatedSeats(reply: ActivityMessages, selected: String?, limit: Int = SEAT_LIMIT): List<Seat> {
    val times = activityTimes(reply.messages)
    val circle = circleOrder(reply).filter { it.id in times }
    val keep = circle.filter { it.id == selected }.take(1)
    // A stable sort keeps the circle order for equal times.
    val others = circle.filter { it.id != selected }.sortedByDescending { times.getValue(it.id) }
    val chosen = (keep + others.take(max(0, limit - keep.size))).map { it.id }.toSet()
    return circle.filter { it.id in chosen }
}

/** The messages a seat sent and received; [badSent] and [badReceived] count the not-sent ones. */
data class SeatCount(val sent: Int = 0, val received: Int = 0, val badSent: Int = 0, val badReceived: Int = 0)

fun seatCounts(messages: List<ActivityMessage>): Map<String, SeatCount> {
    val counts = HashMap<String, SeatCount>()
    for (message in messages) {
        val bad = if (statusKey(message.status) == "not-sent") 1 else 0
        counts[message.from] = counts[message.from].orEmpty().let { it.copy(sent = it.sent + 1, badSent = it.badSent + bad) }
        counts[message.to] = counts[message.to].orEmpty().let { it.copy(received = it.received + 1, badReceived = it.badReceived + bad) }
    }
    return counts
}

private fun SeatCount?.orEmpty() = this ?: SeatCount()

/**
 * One chord: [a] comes first on the circle; [ab] counts a to b, [ba] b to a; [badAb] and [badBa] count the not-sent messages of
 * each direction.
 */
data class Chord(val a: String, val b: String, val ab: Int, val ba: Int, val bad: Boolean, val badAb: Int = 0, val badBa: Int = 0) {
    val n: Int get() = ab + ba
    val key: String get() = "$a|$b"
    /** Some messages are not sent and some are: the chord draws a not-sent receiver end. */
    val mixed: Boolean get() = !bad && badAb + badBa > 0
}

/** One chord per unordered pair of seated seats with messages; [Chord.bad] when every message is not-sent. */
fun chords(messages: List<ActivityMessage>, seated: List<Seat>): List<Chord> {
    val index = seated.mapIndexed { i, seat -> seat.id to i }.toMap()
    data class Tally(var ab: Int = 0, var ba: Int = 0, var badAb: Int = 0, var badBa: Int = 0)
    val pairs = LinkedHashMap<Pair<String, String>, Tally>()
    for (message in messages) {
        val i = index[message.from] ?: continue
        val j = index[message.to] ?: continue
        if (i == j) continue
        val key = if (i < j) message.from to message.to else message.to to message.from
        val tally = pairs.getOrPut(key) { Tally() }
        val forward = message.from == key.first
        if (forward) tally.ab++ else tally.ba++
        if (statusKey(message.status) == "not-sent") { if (forward) tally.badAb++ else tally.badBa++ }
    }
    return pairs.map { (key, t) -> Chord(key.first, key.second, t.ab, t.ba, t.badAb + t.badBa == t.ab + t.ba, t.badAb, t.badBa) }
}

data class MachineRow(val machineIds: List<String>, val label: String, val count: Int)

data class Ledger(
    val total: Int,
    /** Every status in [STATUS_ORDER] with its count (0 included). */
    val byStatus: List<Pair<String, Int>>,
    /** The matrix rows and columns: the three apps, plus "" (Other) when an endpoint has no app. */
    val apps: List<String>,
    /** matrix[from][to] in [apps] order. */
    val matrix: List<List<Int>>,
    val appPairs: Int,
    val machineRows: List<MachineRow>,
    /** The 6 newest messages, newest first. */
    val recent: List<ActivityMessage>,
)

/** The ledger counts every message of the reply (contract 5). */
fun ledger(reply: ActivityMessages): Ledger {
    val seats = reply.seats.associateBy { it.id }
    val app = { id: String -> appKey(seats[id]?.app.orEmpty()) }
    val messages = reply.messages
    val byStatus = STATUS_ORDER.associateWith { 0 }.toMutableMap()
    for (message in messages) byStatus[statusKey(message.status)] = byStatus.getValue(statusKey(message.status)) + 1
    val other = messages.any { app(it.from) == "" || app(it.to) == "" }
    val apps = APP_ORDER + if (other) listOf("") else emptyList()
    val matrix = List(apps.size) { IntArray(apps.size) }
    for (message in messages) matrix[apps.indexOf(app(message.from))][apps.indexOf(app(message.to))]++
    val machineIds = reply.machines.map { it.machineId }
    val names = reply.machines.associate { it.machineId to it.name }
    val machineCounts = HashMap<List<String>, Int>()
    for (message in messages) {
        val a = seats[message.from]?.machineId ?: continue
        val b = seats[message.to]?.machineId ?: continue
        val key = if (a == b) listOf(a) else listOf(a, b).sortedBy { machineIds.indexOf(it).let { i -> if (i < 0) Int.MAX_VALUE else i } }
        machineCounts[key] = (machineCounts[key] ?: 0) + 1
    }
    val pairKeys = machineCounts.keys.filter { it.size == 2 }
        .sortedWith(compareBy({ order(machineIds, it[0]) }, { order(machineIds, it[1]) }))
    val singleKeys = machineCounts.keys.filter { it.size == 1 }.sortedBy { order(machineIds, it[0]) }
    val machineRows = (pairKeys + singleKeys).map { ids ->
        MachineRow(ids, ids.joinToString(" ⇄ ") { names[it] ?: it }, machineCounts.getValue(ids))
    }
    return Ledger(
        total = messages.size,
        byStatus = STATUS_ORDER.map { it to byStatus.getValue(it) },
        apps = apps,
        matrix = matrix.map { it.toList() },
        appPairs = matrix.sumOf { row -> row.count { it > 0 } },
        machineRows = machineRows,
        recent = messages.withIndex().sortedWith(compareBy({ it.value.atMs }, { it.index })).map { it.value }.takeLast(6).reversed(),
    )
}

private fun order(ids: List<String>, id: String): Int = ids.indexOf(id).let { if (it < 0) Int.MAX_VALUE else it }

/** The newest message, or null. */
fun newestMessage(messages: List<ActivityMessage>): ActivityMessage? = messages.withIndex()
    .maxWithOrNull(compareBy({ it.value.atMs }, { it.index }))?.value

/** Ids not in [previous] with a time within 120 s of [nowMs], oldest first; null [previous] (first reply) has none. */
fun arrivals(previous: Set<String>?, messages: List<ActivityMessage>, nowMs: Long): List<ActivityMessage> {
    if (previous == null) return emptyList()
    return messages.filter { it.id !in previous && kotlin.math.abs(nowMs - it.atMs) <= ARRIVAL_WINDOW_MS }
        .withIndex().sortedWith(compareBy({ it.value.atMs }, { it.index })).map { it.value }
}

// ---------- Usage ----------

enum class Metric { COST, TOKENS }

/** [unpricedTokens]: the tokens of the records with no price; [priced]: a record has a price (for `Unpriced` rows). */
data class Amount(val cost: Double = 0.0, val tokens: Long = 0, val unpricedTokens: Long = 0, val priced: Boolean = false) {
    operator fun plus(other: Amount) = Amount(cost + other.cost, tokens + other.tokens, unpricedTokens + other.unpricedTokens,
        priced || other.priced)
    fun value(metric: Metric): Double = if (metric == Metric.COST) cost else tokens.toDouble()
}

data class ModelRow(val model: String, val app: String, val machineIds: List<String>, val cost: Double?, val tokens: Long) {
    fun value(metric: Metric): Double = if (metric == Metric.COST) cost ?: 0.0 else tokens.toDouble()
}

data class UsageTotals(
    val cost: Double,
    val tokens: Long,
    /** The machines that are on, in reply order. */
    val machineIds: List<String>,
    val byMachine: Map<String, Amount>,
    val byMachineApp: Map<String, Map<String, Amount>>,
    /** The chart and row apps: the three base apps, extra apps with tokens, then Other. */
    val apps: List<String>,
    val byApp: Map<String, Amount>,
    val byMaker: Map<String, Amount>,
    val pricedMakers: Set<String>,
    val models: List<ModelRow>,
    val parts: TokenParts,
    /** The cost per token type of the priced records, keyed like [TOKEN_TYPES]. */
    val costParts: Map<String, Double>,
    val savings: Double,
    val unpricedTokens: Long,
    val unpricedModels: List<String>,
    /** Per bucket: the amount per app and per machine. */
    val barsByApp: List<Map<String, Amount>>,
    val barsByMachine: List<Map<String, Amount>>,
)

fun Amount?.orZero() = this ?: Amount()

/** The usage of the machines that are not in [off] (contract 2.3); a record outside the buckets counts in no bar. */
fun usageTotals(reply: ActivityUsage, off: Set<String> = emptySet()): UsageTotals {
    val on = reply.machines.map { it.machineId }.filter { it !in off }
    val onSet = on.toSet()
    val records = reply.records.filter { it.machineId in onSet }
    val other = records.any { usageAppKey(it.app) == "" }
    val extraApps = USAGE_APP_ORDER.drop(APP_ORDER.size).filter { app -> records.any { it.app == app && it.tokens.processed > 0 } }
    val apps = APP_ORDER + extraApps + if (other) listOf("") else emptyList()
    val byMachine = LinkedHashMap<String, Amount>()
    val byMachineApp = LinkedHashMap<String, MutableMap<String, Amount>>()
    for (id in on) { byMachine[id] = Amount(); byMachineApp[id] = apps.associateWith { Amount() }.toMutableMap() }
    val byApp = apps.associateWith { Amount() }.toMutableMap()
    val byMaker = LinkedHashMap<String, Amount>()
    val pricedMakers = mutableSetOf<String>()
    val models = LinkedHashMap<Pair<String, String>, ModelRow>()
    val n = reply.buckets.startsMs.size
    val barsByApp = List(n) { HashMap<String, Amount>() }
    val barsByMachine = List(n) { HashMap<String, Amount>() }
    var uncached = 0L; var cacheRead = 0L; var cacheWrite = 0L; var output = 0L
    val costParts = TOKEN_TYPES.associate { it.first to 0.0 }.toMutableMap()
    var savings = 0.0
    var unpricedTokens = 0L
    val unpricedModels = mutableListOf<String>()
    for (record in records) {
        val app = usageAppKey(record.app)
        val amount = Amount(record.cost?.total ?: 0.0, record.tokens.processed, if (record.cost == null) record.tokens.processed else 0,
            record.cost != null)
        byMachine[record.machineId] = byMachine[record.machineId].orZero() + amount
        val machineApps = byMachineApp.getValue(record.machineId)
        machineApps[app] = machineApps[app].orZero() + amount
        byApp[app] = byApp[app].orZero() + amount
        val maker = record.maker.ifBlank { "Other" }
        byMaker[maker] = byMaker[maker].orZero() + amount
        if (record.cost != null) pricedMakers += maker
        val key = record.model to app
        val row = models[key]
        models[key] = if (row == null) ModelRow(record.model, app, listOf(record.machineId), record.cost?.total, amount.tokens)
            else row.copy(
                machineIds = if (record.machineId in row.machineIds) row.machineIds else row.machineIds + record.machineId,
                // A model is priced or not as a whole; a priced row adds only priced records.
                cost = if (row.cost == null && record.cost == null) null else (row.cost ?: 0.0) + (record.cost?.total ?: 0.0),
                tokens = row.tokens + amount.tokens)
        uncached += record.tokens.uncached; cacheRead += record.tokens.cacheRead
        cacheWrite += record.tokens.cacheWrite; output += record.tokens.output
        val cost = record.cost
        if (cost != null) {
            costParts["cacheRead"] = costParts.getValue("cacheRead") + cost.cacheRead
            costParts["cacheWrite"] = costParts.getValue("cacheWrite") + cost.cacheWrite
            costParts["uncached"] = costParts.getValue("uncached") + cost.uncached
            costParts["output"] = costParts.getValue("output") + cost.output
            savings += cost.savings
        } else {
            unpricedTokens += amount.tokens
            if (record.model !in unpricedModels) unpricedModels += record.model
        }
        if (record.bucket in 0 until n) {
            barsByApp[record.bucket][app] = barsByApp[record.bucket][app].orZero() + amount
            barsByMachine[record.bucket][record.machineId] = barsByMachine[record.bucket][record.machineId].orZero() + amount
        }
    }
    val machineOrder = reply.machines.map { it.machineId }
    return UsageTotals(
        cost = byMachine.values.sumOf { it.cost },
        tokens = byMachine.values.sumOf { it.tokens },
        machineIds = on,
        byMachine = byMachine,
        byMachineApp = byMachineApp,
        apps = apps,
        byApp = byApp,
        byMaker = byMaker,
        pricedMakers = pricedMakers,
        models = models.values.map { row -> row.copy(machineIds = row.machineIds.sortedBy { machineOrder.indexOf(it) }) },
        parts = TokenParts(uncached, cacheRead, cacheWrite, output),
        costParts = costParts,
        savings = savings,
        unpricedTokens = unpricedTokens,
        unpricedModels = unpricedModels,
        barsByApp = barsByApp,
        barsByMachine = barsByMachine,
    )
}

/** Refetch every 2 s while the first scan runs or the prices load, else every 10 s. */
fun usageRefreshMs(reply: ActivityUsage?): Long = when {
    reply != null && (!reply.scan.complete || reply.prices.status == "loading") -> 2_000L
    // All time changes slowly, and its reply is the largest.
    reply?.period == "all" -> 60_000L
    else -> 10_000L
}

/** [old] when [next] differs from it only in nowMs, so the screen does not compute the totals again. */
fun keptUsage(old: ActivityUsage?, next: ActivityUsage): ActivityUsage =
    if (old != null && next.copy(nowMs = 0) == old.copy(nowMs = 0)) old else next

/** Turn a machine on or off; the last machine that is on stays on. */
fun toggleMachine(machineIds: List<String>, off: Set<String>, id: String): Set<String> = when {
    id in off -> off - id
    machineIds.count { it !in off } <= 1 -> off
    else -> off + id
}

/** [unpriced]: a Cost row whose tokens all have no price (`Unpriced`); [noData]: a machine with no report in the period (`No data`). */
data class UsageRow(val key: String, val value: Double, val share: Double, val segments: List<Pair<String, Double>>, val unpriced: Boolean = false,
    val noData: Boolean = false)

/**
 * One row per machine that is on, with its app segments. As usage_row_value: an offline machine of [reply] with no tokens whose
 * last report is before the first bucket has [UsageRow.noData]; in Cost, a machine whose tokens all have no price is unpriced.
 */
fun machineRows(totals: UsageTotals, metric: Metric, reply: ActivityUsage? = null): List<UsageRow> {
    val total = if (metric == Metric.COST) totals.cost else totals.tokens.toDouble()
    val machines = reply?.machines.orEmpty().associateBy { it.machineId }
    val first = reply?.buckets?.startsMs?.firstOrNull()
    return totals.machineIds.map { id ->
        val amount = totals.byMachine[id].orZero()
        val value = amount.value(metric)
        val machine = machines[id]
        val noData = machine != null && first != null && machine.state !in setOf("local", "online") && amount.tokens == 0L &&
            machine.lastReportAtMs < first
        UsageRow(id, value, if (total > 0) value / total else 0.0,
            totals.apps.map { it to totals.byMachineApp[id]?.get(it).orZero().value(metric) }, !noData && amount.allUnpriced(metric), noData)
    }
}

/** One row per app with tokens; in Cost, an app whose tokens all have no price is unpriced. */
fun appRows(totals: UsageTotals, metric: Metric): List<UsageRow> {
    val total = if (metric == Metric.COST) totals.cost else totals.tokens.toDouble()
    return totals.apps.filter { totals.byApp[it].orZero().tokens > 0 }.map { app ->
        val amount = totals.byApp[app].orZero()
        val value = amount.value(metric)
        UsageRow(app, value, if (total > 0) value / total else 0.0, listOf(app to value), amount.allUnpriced(metric))
    }
}

/** Makers with tokens; Other stays last, and unpriced Cost rows follow priced rows. */
fun makerRows(totals: UsageTotals, metric: Metric): List<UsageRow> {
    val total = if (metric == Metric.COST) totals.cost else totals.tokens.toDouble()
    return totals.byMaker.filterValues { it.tokens > 0 }.map { (maker, amount) ->
        val unpriced = metric == Metric.COST && maker !in totals.pricedMakers
        val value = if (unpriced) 0.0 else amount.value(metric)
        UsageRow(maker, value, if (total > 0) value / total else 0.0, listOf(maker to value), unpriced)
    }.sortedWith(compareBy<UsageRow> { it.key == "Other" }.thenBy { it.unpriced }
        .thenByDescending { if (it.unpriced) totals.byMaker.getValue(it.key).tokens.toDouble() else it.value }.thenBy { it.key })
}

/** The note under the rows; null when every token is priced. Callers show it for the Cost metric only. */
fun unpricedNote(totals: UsageTotals, formatTokens: (Long) -> String): String? {
    if (totals.unpricedTokens <= 0) return null
    val models = totals.unpricedModels
    return "${models.joinToString(", ")} ${if (models.size > 1) "are" else "is"} unpriced: " +
        "${formatTokens(totals.unpricedTokens)} tokens not in the cost."
}

/** One arc of the round chart; angles in degrees from -90 (top), clockwise. */
data class RoundArc(val machineId: String, val app: String?, val value: Double, val r0: Float, val r1: Float,
    val a0: Double, val a1: Double, val color: String, val share: Double = 0.0)

/**
 * Inner ring machines (r 109 to 131), outer ring apps (134 to 146) inside each machine's range; arcs below 0.5° are skipped. The
 * share of a machine arc is of the total, of an app arc of its machine.
 */
fun roundArcs(reply: ActivityUsage, totals: UsageTotals, metric: Metric): List<RoundArc> {
    val hues = reply.machines.mapIndexed { index, machine -> machine.machineId to machineHue(index) }.toMap()
    val shown = totals.machineIds.filter { totals.byMachine[it].orZero().value(metric) > 0 }
    val total = shown.sumOf { totals.byMachine.getValue(it).value(metric) }
    val gap = if (shown.size > 1) 1.5 else 0.0
    val available = 360 - gap * shown.size
    var a0 = -90.0
    val arcs = mutableListOf<RoundArc>()
    for (id in shown) {
        val machineValue = totals.byMachine.getValue(id).value(metric)
        val span = if (total > 0) available * machineValue / total else 0.0
        if (span >= .5) arcs += RoundArc(id, null, machineValue, 109f, 131f, a0, a0 + span, hues[id] ?: machineHue(0),
            machineValue / total)
        val apps = totals.apps.filter { totals.byMachineApp[id]?.get(it).orZero().value(metric) > 0 }
        val appAvailable = span - .6 * max(0, apps.size - 1)
        var b0 = a0
        for (app in apps) {
            val value = totals.byMachineApp.getValue(id).getValue(app).value(metric)
            val appSpan = appAvailable * value / machineValue
            if (appSpan >= .5) arcs += RoundArc(id, app, value, 134f, 146f, b0, b0 + appSpan, APP_COLORS.getValue(app),
                value / machineValue)
            b0 += appSpan + .6
        }
        a0 += span + gap
    }
    return arcs
}

/** The chart series ids: the apps, or the machines that are on. */
fun chartSeries(totals: UsageTotals, byMachine: Boolean): List<String> = if (byMachine) totals.machineIds else totals.apps

/** Per bucket, the value of each series in [chartSeries] order. */
fun chartBars(totals: UsageTotals, byMachine: Boolean, metric: Metric): List<List<Double>> {
    val series = chartSeries(totals, byMachine)
    return (if (byMachine) totals.barsByMachine else totals.barsByApp).map { bar -> series.map { bar[it].orZero().value(metric) } }
}

/** The gridline step: the smallest of 1, 2, 2.5, 5, 10 × 10^k at or above [x]. */
fun niceStep(x: Double): Double {
    if (!(x > 0)) return 1.0
    val p = 10.0.pow(floor(log10(x)))
    for (m in listOf(1.0, 2.0, 2.5, 5.0, 10.0)) if (m * p >= x - 1e-12) return m * p
    return 10 * p
}

/** Port of usage_axis: the gridline step (the smallest round step whose fourth line reaches [maxValue]) and 3 or 4 lines. */
fun usageAxis(maxValue: Double): Pair<Double, Int> {
    val step = niceStep(maxValue / 4)
    return step to if (step * 3 >= maxValue - 1e-9) 3 else 4
}

/** Port of usage_ring_note: still reading, 2 of 3 machines, and without 1 unpriced model (Cost only), joined by " · ". */
fun usageRingNote(scanning: Boolean, shown: Int, total: Int, cost: Boolean, unpricedTokens: Long, unpricedModels: Int): String {
    val parts = mutableListOf<String>()
    if (scanning) parts += "still reading"
    if (shown < total) parts += "$shown of $total machines"
    if (cost && unpricedTokens > 0) parts += "without $unpricedModels unpriced model${if (unpricedModels == 1) "" else "s"}"
    // No-break spaces inside a part, so the note breaks only between parts.
    return parts.joinToString(" · ") { it.replace(' ', '\u00a0') }
}

/** Port of usage_cost_basis: the line under the Totals Cost, `if paid at API prices`, then `without 1 unpriced model` (both metrics). */
fun usageCostBasis(totals: UsageTotals): String {
    val parts = mutableListOf("if paid at API prices")
    val count = totals.unpricedModels.size
    if (totals.unpricedTokens > 0) parts += "without $count unpriced model${if (count == 1) "" else "s"}"
    // No-break spaces inside a part, so the line breaks only between parts.
    return parts.joinToString(" · ") { it.replace(' ', '\u00a0') }
}

const val USAGE_SESSION_ROWS = 8

/** One Sessions row: [value] is the cost in Cost and the processed tokens in Tokens; [share] is of the filtered total. */
data class SessionRow(val id: String, val app: String, val title: String, val machineId: String, val value: Double, val cost: Double,
    val tokens: Long, val share: Double, val unpriced: Boolean = false)

/**
 * The rest row: [label] is `Other sessions (N)`, or `Usage with no session` when no other session is left; [next] is how many more
 * sessions its button shows (at most [USAGE_SESSION_ROWS], 0 when no other session has a value).
 */
data class SessionRest(val label: String, val value: Double, val cost: Double, val tokens: Long, val share: Double, val next: Int = 0)

data class SessionsView(val rows: List<SessionRow>, val other: SessionRest?)

/**
 * Port of usage_sessions: the [shown] sessions (8, more after a tap on the rest row) of the machines that are on with the highest
 * value (ties go to the title, then the ID), then a rest row with the rest of the filtered totals, so the rows add up to the
 * totals. Null when the machines that are on have no session in the period (or the reply has no sessions part).
 */
fun usageSessions(reply: ActivityUsage, totals: UsageTotals, metric: Metric, shown: Int = USAGE_SESSION_ROWS): SessionsView? {
    val sessions = reply.sessions ?: return null
    val on = totals.machineIds.toSet()
    val count = on.sumOf { sessions.counts[it] ?: 0 }
    if (count <= 0) return null
    val total = if (metric == Metric.COST) totals.cost else totals.tokens.toDouble()
    val share = { value: Double -> if (total > 0) value / total else 0.0 }
    val rows = sessions.rows.filter { it.machineId in on }.map {
        val value = if (metric == Metric.COST) it.cost else it.tokens.processed.toDouble()
        SessionRow(it.id, usageAppKey(it.app), it.title, it.machineId, value, it.cost, it.tokens.processed, share(value), it.unpriced)
    }.sortedWith(compareByDescending<SessionRow> { it.value }.thenBy { it.title }.thenBy { it.id })
    val valued = rows.filter { it.value > 0 }
    val top = valued.take(shown)
    val more = count - top.size
    // The member sessions cover the member's own hours, so the rest is never below 0.
    val cost = max(0.0, totals.cost - top.sumOf { it.cost })
    val tokens = max(0L, totals.tokens - top.sumOf { it.tokens })
    val value = if (metric == Metric.COST) cost else tokens.toDouble()
    val untied = on.any { (sessions.none[it]?.tokens?.processed ?: 0) > 0 }
    val other = if (more > 0 || (untied && value > 0))
        SessionRest(if (more > 0) "Other sessions ($more)" else "Usage with no session", value, cost, tokens, share(value),
            min(USAGE_SESSION_ROWS, valued.size - top.size)) else null
    return SessionsView(top, other)
}

/** Port of oklab: Björn Ottosson's OKLab (L, a, b) of an sRGB hex color. */
internal fun oklab(color: String): Triple<Double, Double, Double> {
    val (r, g, b) = listOf(1, 3, 5).map {
        val channel = color.substring(it, it + 2).toInt(16) / 255.0
        if (channel <= .04045) channel / 12.92 else ((channel + .055) / 1.055).pow(2.4)
    }
    val l = cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b)
    val m = cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b)
    val s = cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b)
    return Triple(.2104542553 * l + .7936177850 * m - .0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + .4505937099 * s,
        .0259040371 * l + .7827717662 * m - .8086757660 * s)
}

/** Port of oklch_color: the sRGB hex color of an OKLCH color, the chroma lowered in steps of 0.002 until it is inside sRGB. */
internal fun oklchColor(lightness: Double, startChroma: Double, hue: Double): String {
    var chroma = startChroma
    var channels = emptyList<Double>()
    while (true) {
        val a = chroma * cos(Math.toRadians(hue))
        val b = chroma * sin(Math.toRadians(hue))
        val l = (lightness + .3963377774 * a + .2158037573 * b).pow(3)
        val m = (lightness - .1055613458 * a - .0638541728 * b).pow(3)
        val s = (lightness - .0894841775 * a - 1.2914855480 * b).pow(3)
        channels = listOf(4.0767416621 * l - 3.3077115913 * m + .2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s,
            -.0041960863 * l - .7034186147 * m + 1.7076147010 * s)
        if (chroma <= 0 || channels.all { it in -.0001..1.0001 }) break
        chroma = max(0.0, chroma - .002)
    }
    return "#" + channels.joinToString("") {
        val c = it.coerceIn(0.0, 1.0)
        val v = if (c <= .0031308) 12.92 * c else 1.055 * c.pow(1 / 2.4) - .055
        Math.rint(v * 255).toInt().coerceIn(0, 255).toString(16).padStart(2, '0')
    }
}

/**
 * Port of usage_token_ramp: the token type colors, a ramp of the accent in OKLCH in even lightness steps from the floor to the
 * accent. The floor is the lowest lightness from 0.30 up (0.005 steps) at which the floor step has 3:1 on the background. Each
 * step keeps the accent hue, and its chroma scales with its lightness; output is the accent itself.
 */
fun usageTokenRamp(accent: String, background: String): Map<String, String> {
    val (lightness, a, b) = oklab(accent)
    val chroma = hypot(a, b)
    val hue = (Math.toDegrees(atan2(b, a)) % 360 + 360) % 360
    val step = { l: Double -> oklchColor(l, if (lightness > 0) chroma * l / lightness else 0.0, hue) }
    var floor = .30
    while (contrast(step(floor), background) < 3 && floor < 1) floor = Math.rint((floor + .005) * 1000) / 1000
    return TOKEN_TYPES.take(3).mapIndexed { i, (key, _) -> key to step(floor + i * (lightness - floor) / 3) }
        .toMap() + ("output" to accent)
}

/** Chart label intervals by bucket unit and count, counted from the last bar. */
fun chartLabelShown(count: Int, unit: String, index: Int): Boolean {
    val every = when {
        unit == "month" -> when { count <= 12 -> 1; count <= 36 -> 3; else -> 12 }
        unit == "week" -> when { count <= 8 -> 1; count <= 52 -> 4; else -> 8 }
        unit == "hour" -> 3
        count <= 7 -> 1
        count <= 31 -> 5
        else -> 15
    }
    return (count - 1 - index) % every == 0
}

data class UsageFigure(val label: String, val tokens: Long?, val cost: Double?)

/** The three totals: Cost (if paid at API prices), Processed tokens, Cache savings; the token types are in their own block. */
fun usageFigures(totals: UsageTotals): List<UsageFigure> = listOf(
    UsageFigure("Cost", null, totals.cost),
    UsageFigure("Processed tokens", totals.tokens, null),
    UsageFigure("Cache savings", null, totals.savings),
)

/** Tokens by type: (type key, label, tokens, share) in [TOKEN_TYPES] order. */
fun tokenShares(totals: UsageTotals): List<TypeShare> {
    val values = mapOf("cacheRead" to totals.parts.cacheRead, "cacheWrite" to totals.parts.cacheWrite,
        "uncached" to totals.parts.uncached, "output" to totals.parts.output).mapValues { it.value.toDouble() }
    return typeShares(values)
}

/** Cost by type of the priced records. */
fun costShares(totals: UsageTotals): List<TypeShare> = typeShares(totals.costParts)

data class TypeShare(val key: String, val label: String, val value: Double, val share: Double)

private fun typeShares(values: Map<String, Double>): List<TypeShare> {
    val total = values.values.sum()
    return TOKEN_TYPES.map { (key, label) ->
        val value = values[key] ?: 0.0
        TypeShare(key, label, value, if (total > 0) value / total else 0.0)
    }
}

/** The Models rows with tokens: sorted by the metric, descending; for Cost the unpriced rows go last. */
fun modelRows(totals: UsageTotals, metric: Metric): List<ModelRow> {
    val priced = { row: ModelRow -> metric == Metric.TOKENS || row.cost != null }
    return totals.models.filter { it.tokens > 0 }
        .sortedWith(compareByDescending<ModelRow> { priced(it) }.thenByDescending { it.value(metric) })
}

/** A Cost row whose tokens all have no price (port of the `Unpriced` case of usage_row_value). */
private fun Amount.allUnpriced(metric: Metric) = metric == Metric.COST && unpricedTokens > 0 && !priced
