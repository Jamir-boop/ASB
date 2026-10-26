package local.asb.companion

import local.asb.companion.data.APP_COLORS
import local.asb.companion.data.APP_ORDER
import local.asb.companion.data.USAGE_APP_ORDER
import local.asb.companion.data.ActivityMachine
import local.asb.companion.data.CostParts
import local.asb.companion.data.UsageRecord
import local.asb.companion.data.appKey
import local.asb.companion.data.appLabel
import local.asb.companion.data.usageAppKey
import local.asb.companion.data.makerRows
import local.asb.companion.ui.appMark
import local.asb.companion.data.ActivityMessages
import local.asb.companion.data.ActivityUsage
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Chord
import local.asb.companion.data.MachineRow
import local.asb.companion.data.Metric
import local.asb.companion.data.TokenParts
import local.asb.companion.data.activeSeats
import local.asb.companion.data.appRows
import local.asb.companion.data.arrivals
import local.asb.companion.data.bucketIndex
import local.asb.companion.data.chartBars
import local.asb.companion.data.chartLabelShown
import local.asb.companion.data.chartSeries
import local.asb.companion.data.chords
import local.asb.companion.data.circleOrder
import local.asb.companion.data.costShares
import local.asb.companion.data.ledger
import local.asb.companion.data.machineHue
import local.asb.companion.data.machineRows
import local.asb.companion.data.modelRows
import local.asb.companion.data.newestMessage
import local.asb.companion.data.niceStep
import local.asb.companion.data.roundArcs
import local.asb.companion.data.seatCounts
import local.asb.companion.data.seatedSeats
import local.asb.companion.data.stripCounts
import local.asb.companion.data.toggleMachine
import local.asb.companion.data.tokenShares
import local.asb.companion.data.unpricedNote
import local.asb.companion.data.usageFigures
import local.asb.companion.data.usageRefreshMs
import local.asb.companion.data.usageTotals
import local.asb.companion.ui.formatTokens
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ActivityTest {
    private val base = 1_793_000_000_000L
    private val day = 86_400_000L

    // Three machines, all five statuses, an Other endpoint, and a pair whose every message is not-sent.
    private val messagesJson = """
        {"period":"7d","nowMs":${base + 7 * day},"future":1,
         "buckets":{"unit":"day","startsMs":[${(0..6).joinToString(",") { (base + it * day).toString() }}]},
         "machines":[
           {"machineId":"m1","name":"Alpha","self":true,"state":"local","lastReportAtMs":0},
           {"machineId":"m2","name":"Beta","state":"online","lastReportAtMs":0},
           {"machineId":"m3","name":"Gamma","state":"offline","lastReportAtMs":${base + day}}],
         "seats":[
           {"id":"b1","title":"Beta one","app":"opencode","machineId":"m2","order":0},
           {"id":"a2","title":"Alpha two","app":"claude","machineId":"m1","order":1},
           {"id":"c1","title":"Gamma one","app":"codex","machineId":"m3","order":0},
           {"id":"unknown:m1","title":"Other sessions","app":"","machineId":"m1","order":2},
           {"id":"a1","title":"Alpha one","app":"codex","machineId":"m1","order":0},
           {"id":"b2","title":"Beta two","app":"claude","machineId":"m2","order":1}],
         "messages":[
           ${msg("x1", "a1", "b1", 0, "accepted")},
           ${msg("x2", "b1", "a1", 1, "written")},
           ${msg("x3", "a2", "b2", 2, "held")},
           ${msg("x4", "a1", "c1", 3, "not-sent")},
           ${msg("x5", "a1", "c1", 4, "not-sent")},
           ${msg("x6", "b2", "unknown:m1", 5, "unknown")},
           ${msg("x7", "a1", "a2", 6, "accepted")},
           ${msg("x8", "c1", "b1", 6, "accepted", 1000)}],
         "truncated":false}
    """.trimIndent()

    private fun msg(id: String, from: String, to: String, bucket: Int, status: String, extra: Long = 0) =
        """{"id":"$id","from":"$from","to":"$to","atMs":${base + bucket * day + 3_600_000 + extra},"status":"$status","reason":"","local":true}"""

    private val messages = AsbJson.decodeFromString<ActivityMessages>(messagesJson)

    @Test fun messagesReplyDecodes() {
        assertEquals(8, messages.messages.size)
        assertEquals("not-sent", messages.messages[3].status)
        assertEquals(base + day, messages.machines[2].lastReportAtMs)
        assertEquals(7, messages.buckets.startsMs.size)
        assertEquals(ActivityMessages(), AsbJson.decodeFromString<ActivityMessages>("{}"))
    }

    @Test fun ledgerCountsEveryMessageConsistently() {
        val ledger = ledger(messages)
        val total = messages.messages.size
        assertEquals(8, ledger.total)
        assertEquals(listOf("accepted" to 3, "written" to 1, "held" to 1, "not-sent" to 2, "unknown" to 1), ledger.byStatus)
        assertEquals(total, ledger.byStatus.sumOf { it.second })
        // Codex, Claude Code, OpenCode, and Other because one endpoint has no app.
        assertEquals(listOf("codex", "claude", "opencode", ""), ledger.apps)
        assertEquals(listOf(
            listOf(2, 1, 2, 0),
            listOf(0, 1, 0, 1),
            listOf(1, 0, 0, 0),
            listOf(0, 0, 0, 0),
        ), ledger.matrix)
        assertEquals(total, ledger.matrix.sumOf { it.sum() })
        assertEquals(6, ledger.appPairs)
        assertEquals(listOf(
            MachineRow(listOf("m1", "m2"), "Alpha ⇄ Beta", 4),
            MachineRow(listOf("m1", "m3"), "Alpha ⇄ Gamma", 2),
            MachineRow(listOf("m2", "m3"), "Beta ⇄ Gamma", 1),
            // Only rows above 0: no Beta or Gamma row.
            MachineRow(listOf("m1"), "Alpha", 1),
        ), ledger.machineRows)
        assertEquals(total, ledger.machineRows.sumOf { it.count })
        val strip = stripCounts(messages.buckets.startsMs, messages.messages)
        assertEquals(listOf(1, 1, 1, 1, 1, 1, 2), strip)
        assertEquals(total, strip.sum())
        assertEquals(listOf("x8", "x7", "x6", "x5", "x4", "x3"), ledger.recent.map { it.id })
        assertEquals("x8", newestMessage(messages.messages)?.id)
        // Each seat's sent and received match the records.
        val counts = seatCounts(messages.messages)
        for (seat in messages.seats) {
            assertEquals(seat.id, messages.messages.count { it.from == seat.id }, counts[seat.id]?.sent ?: 0)
            assertEquals(seat.id, messages.messages.count { it.to == seat.id }, counts[seat.id]?.received ?: 0)
        }
        assertEquals(total, counts.values.sumOf { it.sent })
        assertEquals(total, counts.values.sumOf { it.received })
    }

    @Test fun noOtherRowWithoutAnEndpointWithoutApp() {
        val plain = messages.copy(messages = messages.messages.filter { it.id != "x6" })
        assertEquals(listOf("codex", "claude", "opencode"), ledger(plain).apps)
        assertEquals(7, ledger(plain).matrix.sumOf { it.sum() })
    }

    @Test fun chordsJoinSeatedPairsAndMarkTheNotSentOnlyPair() {
        assertEquals(listOf("a1", "a2", "unknown:m1", "b1", "b2", "c1"), circleOrder(messages).map { it.id })
        val seated = seatedSeats(messages, null)
        assertEquals(6, seated.size)
        assertEquals(setOf(
            Chord("a1", "b1", 1, 1, false),
            Chord("a2", "b2", 1, 0, false),
            Chord("a1", "c1", 2, 0, true),
            Chord("unknown:m1", "b2", 0, 1, false),
            Chord("a1", "a2", 1, 0, false),
            Chord("b1", "c1", 0, 1, false),
        ), chords(messages.messages, seated).toSet())
        // A pair with one sent message among not-sent ones is not bad.
        val mixed = messages.messages + messages.messages[0].copy(id = "x9", from = "c1", to = "a1", status = "accepted")
        assertFalse(chords(mixed, seated).single { it.key == "a1|c1" }.bad)
        // Only seated seats get chords.
        val two = seated.filter { it.id in setOf("a1", "b1") }
        assertEquals(listOf("a1|b1"), chords(messages.messages, two).map { it.key })
    }

    // Seats p1..p7 on m1 and q1..q7 on m2; m2 is first in the reply, so q1..q7 come first on the circle.
    private val many: ActivityMessages = run {
        val seats = (1..7).flatMap { i ->
            listOf("""{"id":"p$i","title":"P $i","app":"codex","machineId":"m1","order":${i - 1}}""",
                """{"id":"q$i","title":"Q $i","app":"claude","machineId":"m2","order":${i - 1}}""")
        }
        val pairs = listOf("p1" to "p2", "p3" to "p4", "p5" to "p6", "p7" to "q1", "q2" to "q3", "q4" to "q5", "q6" to "q7")
        val list = pairs.mapIndexed { i, (from, to) ->
            """{"id":"k$i","from":"$from","to":"$to","atMs":${base + (i + 1) * 10_000},"status":"accepted"}"""
        }
        AsbJson.decodeFromString("""{"machines":[{"machineId":"m2","name":"Two"},{"machineId":"m1","name":"One"}],
            "seats":[${seats.joinToString(",")}],"messages":[${list.joinToString(",")}]}""")
    }

    @Test fun twelveSeatsGoToTheMostRecentAndTheSelectedSessionKeepsItsSeat() {
        assertEquals((1..7).map { "q$it" } + (1..7).map { "p$it" }, circleOrder(many).map { it.id })
        assertEquals(14, activeSeats(many).size)
        assertEquals((1..7).map { "q$it" } + listOf("p3", "p4", "p5", "p6", "p7"), seatedSeats(many, null).map { it.id })
        // p1 is the oldest; selected, it keeps a seat, and p4 loses the tie with p3 (p3 comes first on the circle).
        assertEquals((1..7).map { "q$it" } + listOf("p1", "p3", "p5", "p6", "p7"), seatedSeats(many, "p1").map { it.id })
        // A selected ID without a seat changes nothing.
        assertEquals(seatedSeats(many, null), seatedSeats(many, "zz"))
        // A tie across machines: q1 and p7 both at 40 s; q1 comes first on the circle.
        val seven = seatedSeats(many, null, limit = 7).map { it.id }
        assertTrue("q1" in seven)
        assertFalse("p7" in seven)
        assertEquals(8, seatedSeats(many, null, limit = 8).size)
    }

    @Test fun arrivalsAreNewIdsWithin120SecondsOldestFirst() {
        val now = base + 1_000_000
        fun m(id: String, ago: Long) = messages.messages[0].copy(id = id, atMs = now - ago)
        val list = listOf(m("old", 200_000), m("seen", 10_000), m("late", 10_000), m("edge", 120_000), m("early", 60_000), m("past", 120_001))
        assertEquals(listOf("edge", "early", "late"), arrivals(setOf("seen"), list, now).map { it.id })
        // The first reply has no arrivals.
        assertEquals(emptyList<String>(), arrivals(null, list, now).map { it.id })
    }

    @Test fun bucketsTakeTheLastStartAtOrBefore() {
        val starts = listOf(100L, 200L, 300L)
        assertEquals(-1, bucketIndex(starts, 99))
        assertEquals(0, bucketIndex(starts, 100))
        assertEquals(1, bucketIndex(starts, 299))
        assertEquals(2, bucketIndex(starts, 1_000))
        assertEquals(listOf("#a28caa", "#7cc48a", "#5fb3b3", "#d6a15e", "#e38fb0", "#b4b86c", "#a28caa"), (0..6).map(::machineHue))
    }

    private val usageJson = """
        {"period":"30d","nowMs":${base + 3 * day},
         "buckets":{"unit":"day","startsMs":[$base,${base + day},${base + 2 * day}]},
         "machines":[
           {"machineId":"m1","name":"Alpha","self":true,"state":"local"},
           {"machineId":"m2","name":"Beta","state":"online"},
           {"machineId":"m3","name":"Gamma","state":"offline","lastReportAtMs":$base}],
         "records":[
           {"machineId":"m1","app":"claude","model":"model-a","bucket":0,
            "tokens":{"uncached":100,"cacheRead":1000,"cacheWrite":200,"output":50},
            "cost":{"uncached":0.1,"cacheRead":0.2,"cacheWrite":0.3,"output":0.4,"total":1.0,"savings":0.5}},
           {"machineId":"m1","app":"codex","model":"model-b","bucket":1,
            "tokens":{"uncached":10,"cacheRead":20,"cacheWrite":30,"output":40},
            "cost":{"uncached":0.5,"cacheRead":0.5,"cacheWrite":0.5,"output":1.0,"total":2.5,"savings":0.25}},
           {"machineId":"m2","app":"claude","model":"model-a","bucket":2,
            "tokens":{"uncached":1,"cacheRead":2,"cacheWrite":3,"output":4},
            "cost":{"uncached":0.1,"cacheRead":0.2,"cacheWrite":0.2,"output":0.25,"total":0.75,"savings":0}},
           {"machineId":"m2","app":"opencode","model":"model-x","bucket":2,
            "tokens":{"uncached":1000,"cacheRead":0,"cacheWrite":0,"output":500},"cost":null},
           {"machineId":"m3","app":"codex","model":"model-y","bucket":1,
            "tokens":{"uncached":5,"cacheRead":5,"cacheWrite":5,"output":5}}],
         "prices":{"source":"LiteLLM","status":"fresh","fetchedAtMs":$base,"models":2131},
         "scan":{"complete":true,"files":3,"scannedFiles":3}}
    """.trimIndent()

    private val usage = AsbJson.decodeFromString<ActivityUsage>(usageJson)

    @Test fun usageTotalsAreConsistent() {
        val totals = usageTotals(usage)
        assertEquals(4.25, totals.cost, .01)
        assertEquals(2980L, totals.tokens)
        assertEquals(totals.cost, totals.byMachine.values.sumOf { it.cost }, .01)
        assertEquals(totals.cost, totals.byApp.values.sumOf { it.cost }, .01)
        assertEquals(totals.cost, totals.models.sumOf { it.cost ?: 0.0 }, .01)
        assertEquals(totals.tokens, totals.byMachine.values.sumOf { it.tokens })
        assertEquals(totals.tokens, totals.byApp.values.sumOf { it.tokens })
        assertEquals(totals.tokens, totals.models.sumOf { it.tokens })
        // Processed = the four parts.
        assertEquals(totals.tokens, totals.parts.uncached + totals.parts.cacheRead + totals.parts.cacheWrite + totals.parts.output)
        assertEquals(TokenParts(uncached = 1116, cacheRead = 1027, cacheWrite = 238, output = 599), totals.parts)
        // The rows and the chart add up to the same totals.
        for (metric in Metric.entries) {
            val total = if (metric == Metric.COST) totals.cost else totals.tokens.toDouble()
            assertEquals(total, machineRows(totals, metric).sumOf { it.value }, .01)
            assertEquals(total, appRows(totals, metric).sumOf { it.value }, .01)
            assertEquals(1.0, machineRows(totals, metric).sumOf { it.share }, .001)
            for (byMachine in listOf(false, true)) assertEquals(total, chartBars(totals, byMachine, metric).sumOf { it.sum() }, .01)
        }
        assertEquals(listOf(3.5, .75, 0.0), machineRows(totals, Metric.COST).map { it.value })
        assertEquals(listOf("codex", "claude", "opencode"), chartSeries(totals, false))
        assertEquals(listOf("m1", "m2", "m3"), chartSeries(totals, true))
        val figures = usageFigures(totals)
        assertEquals(listOf("Processed tokens", "Cached input", "Uncached input", "Output", "Cache savings"), figures.map { it.label })
        assertEquals(listOf(2980L, 1027L + 238, 1116L, 599L, null), figures.map { it.tokens })
        assertEquals(.75, figures.last().cost!!, .001)
        assertEquals(1.0, tokenShares(totals).sumOf { it.share }, .001)
        assertEquals(listOf("Cache read", "Cache write", "Uncached input", "Output"), tokenShares(totals).map { it.label })
        assertEquals(totals.cost, costShares(totals).sumOf { it.value }, .01)
    }

    @Test fun unpricedNoteIsSingularOrPlural() {
        assertEquals("model-x, model-y are unpriced: 1.5K tokens not in the cost.", unpricedNote(usageTotals(usage), ::formatTokens))
        assertEquals("model-x is unpriced: 1.5K tokens not in the cost.", unpricedNote(usageTotals(usage, setOf("m3")), ::formatTokens))
        assertNull(unpricedNote(usageTotals(usage, setOf("m2", "m3")), ::formatTokens))
    }

    @Test fun modelRowsSortByTheMetricWithUnpricedLast() {
        val totals = usageTotals(usage)
        assertEquals(listOf("model-b", "model-a", "model-x", "model-y"), modelRows(totals, Metric.COST).map { it.model })
        assertEquals(listOf(null, null), modelRows(totals, Metric.COST).takeLast(2).map { it.cost })
        assertEquals(listOf("model-x", "model-a", "model-b", "model-y"), modelRows(totals, Metric.TOKENS).map { it.model })
        assertEquals(listOf("m1", "m2"), totals.models.single { it.model == "model-a" }.machineIds)
    }

    @Test fun theLastMachineThatIsOnStaysOn() {
        val ids = listOf("m1", "m2", "m3")
        assertEquals(setOf("m1"), toggleMachine(ids, emptySet(), "m1"))
        assertEquals(emptySet<String>(), toggleMachine(ids, setOf("m1"), "m1"))
        assertEquals(setOf("m1", "m2"), toggleMachine(ids, setOf("m1"), "m2"))
        assertEquals(setOf("m1", "m2"), toggleMachine(ids, setOf("m1", "m2"), "m3"))
        val totals = usageTotals(usage, setOf("m1", "m2"))
        assertEquals(listOf("m3"), totals.machineIds)
        assertEquals(20L, totals.tokens)
        assertEquals(0.0, totals.cost, .001)
    }

    @Test fun roundChartArcsFollowThePreview() {
        val totals = usageTotals(usage)
        val arcs = roundArcs(usage, totals, Metric.COST)
        val machineArcs = arcs.filter { it.app == null }
        // m3 has no cost, so two machines with a 1.5° gap each.
        assertEquals(listOf("m1", "m2"), machineArcs.map { it.machineId })
        assertEquals(-90.0, machineArcs[0].a0, 1e-9)
        assertEquals(357.0, machineArcs.sumOf { it.a1 - it.a0 }, 1e-6)
        assertEquals(357.0 * 3.5 / 4.25, machineArcs[0].a1 - machineArcs[0].a0, 1e-6)
        assertEquals(listOf("#a28caa", "#7cc48a"), machineArcs.map { it.color })
        // Apps sit inside their machine's range, 0.6° apart.
        val m1Apps = arcs.filter { it.machineId == "m1" && it.app != null }
        assertEquals(listOf("codex", "claude"), m1Apps.map { it.app })
        assertEquals(machineArcs[0].a1 - machineArcs[0].a0 - .6, m1Apps.sumOf { it.a1 - it.a0 }, 1e-6)
        assertTrue(arcs.all { it.a1 - it.a0 >= .5 })
        assertEquals(listOf(92f, 114f), listOf(machineArcs[0].r0, machineArcs[0].r1))
        assertEquals(listOf(118f, 146f), listOf(m1Apps[0].r0, m1Apps[0].r1))
        assertEquals(3, roundArcs(usage, totals, Metric.TOKENS).count { it.app == null })
    }

    @Test fun chartTicksAndLabels() {
        assertEquals(1.0, niceStep(0.0), 0.0)
        assertEquals(2.5, niceStep(2.1), 1e-9)
        assertEquals(500.0, niceStep(420.0), 1e-9)
        assertEquals(1000.0, niceStep(501.0), 1e-9)
        assertEquals((0..6).toList(), (0..6).filter { chartLabelShown(7, false, it) })
        assertEquals(listOf(4, 9, 14, 19, 24, 29), (0..29).filter { chartLabelShown(30, false, it) })
        assertEquals(listOf(14, 29, 44, 59, 74, 89), (0..89).filter { chartLabelShown(90, false, it) })
        assertEquals(listOf(2, 5, 8, 11, 14, 17, 20, 23), (0..23).filter { chartLabelShown(24, true, it) })
    }

    @Test fun usageRefetchesEveryTwoSecondsWhileScanningOrLoadingPrices() {
        assertEquals(10_000L, usageRefreshMs(null))
        assertEquals(10_000L, usageRefreshMs(usage))
        assertEquals(2_000L, usageRefreshMs(usage.copy(scan = usage.scan.copy(complete = false))))
        assertEquals(2_000L, usageRefreshMs(usage.copy(prices = usage.prices.copy(status = "loading", fetchedAtMs = null))))
        assertEquals(10_000L, usageRefreshMs(usage.copy(prices = usage.prices.copy(status = "unavailable", fetchedAtMs = null))))
        val loading = AsbJson.decodeFromString<ActivityUsage>("""{"prices":{"source":"LiteLLM","status":"loading","fetchedAtMs":null,"models":0}}""")
        assertNull(loading.prices.fetchedAtMs)
        assertEquals(base, usage.prices.fetchedAtMs)
    }

    @Test fun usageAppsExtendUsageWithoutChangingMessages() {
        val apps = listOf("codex", "claude", "grok", "pi", "cursor", "antigravity")
        val reply = usage.copy(records = apps.map { UsageRecord(machineId = "m1", app = it, tokens = TokenParts(output = 100)) })
        val totals = usageTotals(reply)
        val expected = listOf("codex", "claude", "opencode", "antigravity", "grok", "pi", "")
        assertEquals(expected, totals.apps)
        assertEquals(100L, totals.byApp.getValue("").tokens)
        assertEquals(expected, chartSeries(totals, false))
        assertEquals(expected, machineRows(totals, Metric.TOKENS).first().segments.map { it.first })
        assertEquals(expected.filter { it != "opencode" }, roundArcs(reply, totals, Metric.TOKENS).mapNotNull { it.app })
        assertTrue(totals.apps.all { it in APP_COLORS })
        assertEquals(listOf("Antigravity", "Grok", "Pi"), USAGE_APP_ORDER.drop(3).map(::appLabel))
        assertEquals(listOf("#4f8fe0", "#e8e46a", "#c678dd"), USAGE_APP_ORDER.drop(3).map { APP_COLORS.getValue(it) })
        assertEquals(APP_ORDER, usageTotals(reply.copy(records = reply.records.take(1))).apps)
        assertEquals(APP_ORDER, usageTotals(reply, setOf("m1")).apps)
        assertEquals(APP_ORDER, usageTotals(reply.copy(records = reply.records.map { it.copy(tokens = TokenParts(), app = "pi") })).apps)
        for (app in listOf("antigravity", "grok", "pi")) {
            assertEquals(app, usageAppKey(app))
            assertEquals("", appKey(app))
        }
        assertEquals("", usageAppKey("cursor"))
        assertEquals(listOf("codex", "claude", "opencode", ""), ledger(messages).apps)
        val unknownApps = messages.copy(seats = messages.seats.map { if (it.app == "") it.copy(app = "pi") else it })
        assertEquals(ledger(messages), ledger(unknownApps))
    }

    @Test fun usageAppMarksKeepExistingMarks() {
        assertEquals(R.drawable.ic_provider_openai, appMark("codex"))
        assertEquals(R.drawable.ic_provider_claude, appMark("claude"))
        assertEquals(R.drawable.ic_provider_opencode, appMark("opencode"))
        assertEquals(R.drawable.ic_machine, appMark("x"))
        assertEquals(R.drawable.ic_machine, appMark(""))
        for (app in listOf("antigravity", "grok", "pi")) assertEquals(R.drawable.ic_terminal, appMark(app))
    }

    private val makerUsage = ActivityUsage(machines = listOf(ActivityMachine(machineId = "m1"), ActivityMachine(machineId = "m2")),
        records = listOf(
            UsageRecord(machineId = "m1", maker = "Anthropic", tokens = TokenParts(output = 100), cost = CostParts(total = 2.0)),
            UsageRecord(machineId = "m1", maker = "Xiaomi MiMo", tokens = TokenParts(output = 1000)),
            UsageRecord(machineId = "m1", maker = "Other", tokens = TokenParts(output = 500), cost = CostParts(total = 3.0)),
            UsageRecord(machineId = "m1", maker = "Google", tokens = TokenParts(output = 200)),
            UsageRecord(machineId = "m1", maker = "Anthropic", tokens = TokenParts(output = 50)),
            UsageRecord(machineId = "m2", maker = "OpenAI", tokens = TokenParts(output = 4000), cost = CostParts(total = 8.0)),
        ))

    @Test fun makerRowsSortByMetricAndKeepOtherLast() {
        val totals = usageTotals(makerUsage, setOf("m2"))
        assertEquals(setOf("Anthropic", "Other"), totals.pricedMakers)
        assertEquals(totals.cost, totals.byMaker.values.sumOf { it.cost }, .001)
        assertEquals(totals.tokens, totals.byMaker.values.sumOf { it.tokens })
        val cost = makerRows(totals, Metric.COST)
        assertEquals(listOf("Anthropic", "Xiaomi MiMo", "Google", "Other"), cost.map { it.key })
        assertEquals(listOf(false, true, true, false), cost.map { it.unpriced })
        assertEquals(listOf(2.0, 0.0, 0.0, 3.0), cost.map { it.value })
        assertEquals(listOf(.4, 0.0, 0.0, .6), cost.map { it.share })
        val tokens = makerRows(totals, Metric.TOKENS)
        assertEquals(listOf("Xiaomi MiMo", "Google", "Anthropic", "Other"), tokens.map { it.key })
        assertTrue(tokens.none { it.unpriced })
        for (metric in Metric.entries) {
            val rows = makerRows(totals, metric)
            assertEquals(1.0, rows.sumOf { it.share }, .001)
            assertTrue(rows.all { it.segments == listOf(it.key to it.value) })
        }
        assertEquals("OpenAI", makerRows(usageTotals(makerUsage, setOf("m1")), Metric.COST).single().key)
    }

    @Test fun makerRowsHandleTiesZeroCostsAndNoTokens() {
        val reply = makerUsage.copy(records = listOf("Z", "A", "Other").flatMap { maker -> listOf(
            UsageRecord(machineId = "m1", maker = maker, tokens = TokenParts(output = 10), cost = CostParts()),
            UsageRecord(machineId = "m1", maker = "Unpriced $maker", tokens = TokenParts(output = 20)),
        ) } + UsageRecord(machineId = "m1", maker = "No tokens"))
        val totals = usageTotals(reply)
        val rows = makerRows(totals, Metric.COST)
        assertEquals(listOf("A", "Z", "Unpriced A", "Unpriced Other", "Unpriced Z", "Other"), rows.map { it.key })
        assertTrue(rows.all { it.share == 0.0 })
        assertFalse(rows.first().unpriced)
        assertEquals(listOf("Unpriced A", "Unpriced Other", "Unpriced Z", "A", "Z", "Other"),
            makerRows(totals, Metric.TOKENS).map { it.key })
        assertTrue(makerRows(usageTotals(ActivityUsage()), Metric.COST).isEmpty())
    }

    @Test fun missingBlankAndNonStringMakersCountAsOther() {
        for (field in listOf("", "null", "42", "true", "[]", "{}", "\"\"", "\"   \"")) {
            val maker = if (field == "") "" else ",\"maker\":$field"
            val reply = AsbJson.decodeFromString<ActivityUsage>("""{"machines":[{"machineId":"m1"}],
                "records":[{"machineId":"m1","tokens":{"output":10}$maker,"future":true}]}""")
            val totals = usageTotals(reply)
            assertEquals(setOf("Other"), totals.byMaker.keys)
            assertEquals(10L, totals.byMaker.getValue("Other").tokens)
            assertTrue(makerRows(totals, Metric.COST).single().unpriced)
        }
    }
}
