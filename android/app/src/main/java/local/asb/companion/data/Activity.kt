package local.asb.companion.data

import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.pow
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
)

@Serializable
data class ActivityMessages(
    val period: String = "7d",
    @Serializable(with = MillisSerializer::class) val nowMs: Long = 0,
    val buckets: ActivityBuckets = ActivityBuckets(),
    val machines: List<ActivityMachine> = emptyList(),
    val seats: List<Seat> = emptyList(),
    val messages: List<ActivityMessage> = emptyList(),
    val truncated: Boolean = false,
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
)

val MESSAGE_PERIODS = listOf("24h", "7d", "30d")
val USAGE_PERIODS = listOf("24h", "7d", "30d", "90d", "all")
const val SEAT_LIMIT = 12
const val ARRIVAL_WINDOW_MS = 120_000L

/** The apps in matrix and chart order; "" is Other. */
val APP_ORDER = listOf("codex", "claude", "opencode")
val USAGE_APP_ORDER = APP_ORDER + listOf("antigravity", "grok", "pi")
val STATUS_ORDER = listOf("accepted", "written", "held", "not-sent", "unknown")

val MACHINE_HUES = listOf("#a28caa", "#7cc48a", "#5fb3b3", "#d6a15e", "#e38fb0", "#b4b86c")
val APP_COLORS = mapOf("codex" to "#c9ccd1", "claude" to "#d97757", "opencode" to "#7d848c",
    "antigravity" to "#4f8fe0", "grok" to "#e8e46a", "pi" to "#c678dd", "" to "#5d6268")
val STATUS_COLORS = mapOf("accepted" to "#c9ccd1", "written" to "#8c929a", "held" to "#e0b45a",
    "not-sent" to "#f5a090", "unknown" to "#5d6268")
val TOKEN_TYPES = listOf("cacheRead" to "Cache read", "cacheWrite" to "Cache write", "uncached" to "Uncached input", "output" to "Output")
val TOKEN_COLORS = mapOf("cacheRead" to "#4b5058", "cacheWrite" to "#6b7179", "uncached" to "#959ba3", "output" to "#e4e6e8")

fun periodLabel(period: String): String = when (period) {
    "24h" -> "24 hours"
    "7d" -> "7 days"
    "30d" -> "30 days"
    "90d" -> "90 days"
    "all" -> "All time"
    else -> period
}

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
    "written" -> "Socket written"
    "held" -> "Held"
    "not-sent" -> "Not sent"
    else -> "Unknown"
}

fun statusKey(status: String): String = if (status in STATUS_ORDER) status else "unknown"

/** The hue of the machine at [index] in machine order; the list repeats. */
fun machineHue(index: Int): String = MACHINE_HUES[index.coerceAtLeast(0) % MACHINE_HUES.size]

// ---------- Messages ----------

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

data class SeatCount(val sent: Int = 0, val received: Int = 0)

fun seatCounts(messages: List<ActivityMessage>): Map<String, SeatCount> {
    val counts = HashMap<String, SeatCount>()
    for (message in messages) {
        counts[message.from] = counts[message.from].orEmpty().let { it.copy(sent = it.sent + 1) }
        counts[message.to] = counts[message.to].orEmpty().let { it.copy(received = it.received + 1) }
    }
    return counts
}

private fun SeatCount?.orEmpty() = this ?: SeatCount()

/** One chord: [a] comes first on the circle; [ab] counts a to b, [ba] b to a. */
data class Chord(val a: String, val b: String, val ab: Int, val ba: Int, val bad: Boolean) {
    val n: Int get() = ab + ba
    val key: String get() = "$a|$b"
}

/** One chord per unordered pair of seated seats with messages; [Chord.bad] when every message is not-sent. */
fun chords(messages: List<ActivityMessage>, seated: List<Seat>): List<Chord> {
    val index = seated.mapIndexed { i, seat -> seat.id to i }.toMap()
    data class Tally(var ab: Int = 0, var ba: Int = 0, var bad: Int = 0)
    val pairs = LinkedHashMap<Pair<String, String>, Tally>()
    for (message in messages) {
        val i = index[message.from] ?: continue
        val j = index[message.to] ?: continue
        if (i == j) continue
        val key = if (i < j) message.from to message.to else message.to to message.from
        val tally = pairs.getOrPut(key) { Tally() }
        if (message.from == key.first) tally.ab++ else tally.ba++
        if (statusKey(message.status) == "not-sent") tally.bad++
    }
    return pairs.map { (key, t) -> Chord(key.first, key.second, t.ab, t.ba, t.bad == t.ab + t.ba) }
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

/** The bucket of a time: the last start at or before it; -1 before the first start. */
fun bucketIndex(startsMs: List<Long>, atMs: Long): Int = startsMs.indexOfLast { it <= atMs }

/** The message count per bucket. */
fun stripCounts(startsMs: List<Long>, messages: List<ActivityMessage>): List<Int> {
    val counts = IntArray(startsMs.size)
    for (message in messages) bucketIndex(startsMs, message.atMs).takeIf { it >= 0 }?.let { counts[it]++ }
    return counts.toList()
}

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

data class Amount(val cost: Double = 0.0, val tokens: Long = 0) {
    operator fun plus(other: Amount) = Amount(cost + other.cost, tokens + other.tokens)
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
        val amount = Amount(record.cost?.total ?: 0.0, record.tokens.processed)
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
fun usageRefreshMs(reply: ActivityUsage?): Long =
    if (reply != null && (!reply.scan.complete || reply.prices.status == "loading")) 2_000L else 10_000L

/** Turn a machine on or off; the last machine that is on stays on. */
fun toggleMachine(machineIds: List<String>, off: Set<String>, id: String): Set<String> = when {
    id in off -> off - id
    machineIds.count { it !in off } <= 1 -> off
    else -> off + id
}

data class UsageRow(val key: String, val value: Double, val share: Double, val segments: List<Pair<String, Double>>, val unpriced: Boolean = false)

/** One row per machine that is on, with its app segments. */
fun machineRows(totals: UsageTotals, metric: Metric): List<UsageRow> {
    val total = if (metric == Metric.COST) totals.cost else totals.tokens.toDouble()
    return totals.machineIds.map { id ->
        val value = totals.byMachine[id].orZero().value(metric)
        UsageRow(id, value, if (total > 0) value / total else 0.0,
            totals.apps.map { it to totals.byMachineApp[id]?.get(it).orZero().value(metric) })
    }
}

/** One row per app with tokens. */
fun appRows(totals: UsageTotals, metric: Metric): List<UsageRow> {
    val total = if (metric == Metric.COST) totals.cost else totals.tokens.toDouble()
    return totals.apps.filter { totals.byApp[it].orZero().tokens > 0 }.map { app ->
        val value = totals.byApp[app].orZero().value(metric)
        UsageRow(app, value, if (total > 0) value / total else 0.0, listOf(app to value))
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
    val a0: Double, val a1: Double, val color: String)

/** Inner ring machines (r 92 to 114), outer ring apps (118 to 146) inside each machine's range; arcs below 0.5° are skipped. */
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
        if (span >= .5) arcs += RoundArc(id, null, machineValue, 92f, 114f, a0, a0 + span, hues[id] ?: machineHue(0))
        val apps = totals.apps.filter { totals.byMachineApp[id]?.get(it).orZero().value(metric) > 0 }
        val appAvailable = span - .6 * max(0, apps.size - 1)
        var b0 = a0
        for (app in apps) {
            val value = totals.byMachineApp.getValue(id).getValue(app).value(metric)
            val appSpan = appAvailable * value / machineValue
            if (appSpan >= .5) arcs += RoundArc(id, app, value, 118f, 146f, b0, b0 + appSpan, APP_COLORS.getValue(app))
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

/** Chart label intervals by bucket unit and count, counted from the last bar. */
fun chartLabelShown(count: Int, unit: String, index: Int): Boolean {
    val every = when {
        unit == "month" -> when { count <= 12 -> 1; count <= 36 -> 3; else -> 12 }
        unit == "hour" -> 3
        count == 7 -> 1
        count == 30 -> 5
        else -> 15
    }
    return (count - 1 - index) % every == 0
}

data class UsageFigure(val label: String, val tokens: Long?, val cost: Double?)

/** The five totals: Processed tokens, Cached input, Uncached input, Output, Cache savings. */
fun usageFigures(totals: UsageTotals): List<UsageFigure> = listOf(
    UsageFigure("Processed tokens", totals.tokens, null),
    UsageFigure("Cached input", totals.parts.cacheRead + totals.parts.cacheWrite, null),
    UsageFigure("Uncached input", totals.parts.uncached, null),
    UsageFigure("Output", totals.parts.output, null),
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
