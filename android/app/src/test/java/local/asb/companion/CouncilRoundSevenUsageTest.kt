package local.asb.companion

import java.util.TimeZone
import local.asb.companion.data.ActivityBuckets
import local.asb.companion.data.ActivityMachine
import local.asb.companion.data.ActivityUsage
import local.asb.companion.data.CostParts
import local.asb.companion.data.Metric
import local.asb.companion.data.TokenParts
import local.asb.companion.data.UsageRecord
import local.asb.companion.data.UsageSession
import local.asb.companion.data.UsageSessions
import local.asb.companion.data.appRows
import local.asb.companion.data.machineRows
import local.asb.companion.data.usageSessions
import local.asb.companion.data.usageTotals
import local.asb.companion.ui.axisLabels
import local.asb.companion.ui.hourWeekdays
import local.asb.companion.ui.measureColumns
import local.asb.companion.ui.moreSessionsLabel
import local.asb.companion.ui.rankedHeadName
import local.asb.companion.ui.rowWord
import local.asb.companion.ui.sessionMachine
import local.asb.companion.ui.sessionScope
import local.asb.companion.ui.sessionSpoken
import local.asb.companion.ui.tooltipTitle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The PC round 6 and round 7 Usage changes on Android: the ranked columns, the Sessions rank, machine, and rest row button,
// Unpriced and No data in the overview rows, and the weekday hour ticks. Made-up machines and sessions only.
class CouncilRoundSevenUsageTest {
    private fun at(text: String) = java.time.Instant.parse(text).toEpochMilli()

    private fun utc(body: () -> Unit) {
        val zone = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
        try { body() } finally { TimeZone.setDefault(zone) }
    }

    private fun record(machineId: String, app: String, tokens: Long, cost: Double?) = UsageRecord(machineId, app, "model-a", "", 0,
        TokenParts(uncached = tokens), cost?.let { CostParts(uncached = it, total = it) })

    @Test fun theRankedMeasureComesFirstWithItsArrowHead() {
        assertEquals(listOf("Cost", "Tokens"), measureColumns(Metric.COST))
        assertEquals(listOf("Tokens", "Cost"), measureColumns(Metric.TOKENS))
        assertEquals("Cost, sorted from high to low", rankedHeadName(Metric.COST))
        assertEquals("Tokens, sorted from high to low", rankedHeadName(Metric.TOKENS))
    }

    // Desk (online) has 20 sessions: cost 1..20, tokens 2000..100; Lab (offline) has 2 tied sessions and one with no value.
    private val desk = (1..20).map { UsageSession("m1", "d$it", "claude", "Desk task $it", TokenParts(output = (21 - it) * 100L), it.toDouble()) }
    private val lab = listOf(UsageSession("m2", "lb", "codex", "Same", TokenParts(output = 3000), 30.0),
        UsageSession("m2", "la", "codex", "Same", TokenParts(output = 3000), 30.0),
        UsageSession("m2", "lz", "codex", "Empty", TokenParts(), 0.0))
    private val reply = ActivityUsage(
        buckets = ActivityBuckets("day", listOf(0L)),
        machines = listOf(ActivityMachine("m1", "Desk", state = "online"), ActivityMachine("m2", "Lab", state = "offline")),
        records = listOf(record("m1", "claude", desk.sumOf { it.tokens.processed }, desk.sumOf { it.cost }),
            record("m2", "codex", 6000, 60.0)),
        sessions = UsageSessions(desk + lab, mapOf("m1" to 20, "m2" to 3)),
    )

    @Test fun sessionsRankByCostAndByTokensWithTies() {
        val totals = usageTotals(reply)
        // Cost: the two Lab ties (title Same, then the ID), then Desk 20 down.
        assertEquals(listOf("la", "lb", "d20", "d19", "d18", "d17", "d16", "d15"), usageSessions(reply, totals, Metric.COST)!!.rows.map { it.id })
        // Tokens: the Lab ties (3000), then Desk 1 (2000) up.
        assertEquals(listOf("la", "lb", "d1", "d2", "d3", "d4", "d5", "d6"), usageSessions(reply, totals, Metric.TOKENS)!!.rows.map { it.id })
    }

    @Test fun aSessionRowNamesItsMachine() {
        val (deskMachine, labMachine) = reply.machines
        assertEquals("Desk", sessionMachine(deskMachine.name, false))
        assertEquals("Lab (offline)", sessionMachine(labMachine.name, true))
        assertEquals("Desk task 20, Claude Code, Desk, $20.00, 7.4% of the cost",
            sessionSpoken("Desk task 20", "Claude Code", sessionMachine(deskMachine.name, false), "$20.00", 20 / 270.0, Metric.COST))
        assertEquals("Same, Codex, Lab (offline), 3K, 11.1% of the tokens",
            sessionSpoken("Same", "Codex", sessionMachine(labMachine.name, true), "3K", 3000 / 27000.0, Metric.TOKENS))
    }

    @Test fun theRestRowShowsEightMoreThenTheRest() {
        val totals = usageTotals(reply)
        // 22 sessions with a value, 23 in all.
        val first = usageSessions(reply, totals, Metric.COST)!!
        assertEquals(8, first.rows.size)
        assertEquals("Other sessions (15)" to 8, first.other!!.label to first.other!!.next)
        assertEquals("Show 8 more sessions", moreSessionsLabel(first.other!!.next))
        val second = usageSessions(reply, totals, Metric.COST, 16)!!
        assertEquals(first.rows, second.rows.take(8))
        assertEquals(16, second.rows.size)
        assertEquals("Other sessions (7)" to 6, second.other!!.label to second.other!!.next)
        assertEquals("Show 6 more sessions", moreSessionsLabel(6))
        assertEquals("Show 1 more session", moreSessionsLabel(1))
        // All 22 with a value show; the session with no value is left, so the button goes away.
        val third = usageSessions(reply, totals, Metric.COST, 24)!!
        assertEquals(22, third.rows.size)
        assertEquals("Other sessions (1)" to 0, third.other!!.label to third.other!!.next)
        for (view in listOf(first, second, third)) assertEquals(totals.cost, view.rows.sumOf { it.cost } + view.other!!.cost, 1e-6)
        // The added rows reset when the period, the metric, or the machine chips change, and stay over a refresh.
        val scope = sessionScope("7d", Metric.COST, listOf("m1", "m2"))
        assertEquals(scope, sessionScope("7d", Metric.COST, listOf("m1", "m2")))
        assertNotEquals(scope, sessionScope("30d", Metric.COST, listOf("m1", "m2")))
        assertNotEquals(scope, sessionScope("7d", Metric.TOKENS, listOf("m1", "m2")))
        assertNotEquals(scope, sessionScope("7d", Metric.COST, listOf("m1")))
    }

    @Test fun overviewRowsReadUnpricedAndNoData() {
        val start = at("2026-11-01T00:00:00Z")
        val usage = ActivityUsage(
            buckets = ActivityBuckets("day", listOf(start)),
            machines = listOf(ActivityMachine("m1", "Desk", state = "local"), ActivityMachine("m2", "Spare", state = "offline", lastReportAtMs = start - 1),
                ActivityMachine("m3", "Lab", state = "offline", lastReportAtMs = start + 1), ActivityMachine("m4", "Box", state = "online")),
            records = listOf(record("m1", "claude", 100, 2.0), record("m1", "codex", 50, null), record("m4", "codex", 70, null)),
        )
        val totals = usageTotals(usage)
        val cost = machineRows(totals, Metric.COST, usage)
        // Reply order; Spare is offline with no tokens and no report in the period; Lab reported in the period; Box has only unpriced tokens.
        assertEquals(listOf(null, "No data", null, "Unpriced"), cost.map(::rowWord))
        assertEquals(listOf(null, "No data", null, null), machineRows(totals, Metric.TOKENS, usage).map(::rowWord))
        // Apps: Codex has only unpriced tokens in Cost.
        assertEquals(listOf("codex" to "Unpriced", "claude" to null), appRows(totals, Metric.COST).map { it.key to rowWord(it) })
        assertTrue(appRows(totals, Metric.TOKENS).all { rowWord(it) == null })
        // Without the reply, no row has No data.
        assertFalse(machineRows(totals, Metric.COST).any { it.noData })
    }

    @Test fun hourTicksNameTheirWeekday() = utc {
        val measure = { text: String -> 7f * text.length }
        // Sun 17:00 to Mon 16:00: the first tick is on the day before the last bucket, and 01:00 is the first tick of Monday.
        val hours = List(24) { at("2026-11-08T17:00:00Z") + it * 3_600_000L }
        val wide = axisLabels(hours, "hour", List(24) { it * 800f / 23 }, 800f, 4f, measure, endGap = 16f)
        assertEquals(listOf("Sun 19:00", "22:00", "Mon 01:00", "04:00", "07:00", "10:00", "13:00", "16:00"), wide.map { it.text })
        // A tight chart keeps the weekday labels and 16 dp beside them; regular labels keep 4 dp.
        val width = 352f
        val centers = List(24) { it * width / 23 }
        val narrow = axisLabels(hours, "hour", centers, width, 4f, measure, endGap = 16f)
        assertTrue(narrow.map { it.text }.containsAll(listOf("Sun 19:00", "Mon 01:00", "16:00")))
        val left = { index: Int, w: Float -> if (index == 23) width - w else centers[index].coerceIn(w / 2, width - w / 2) - w / 2 }
        for ((a, b) in narrow.zipWithNext()) {
            val strong = ' ' in a.text || ' ' in b.text || b.index == 23
            val room = left(b.index, measure(b.text)) - (left(a.index, measure(a.text)) + measure(a.text))
            assertTrue("${a.text} ${b.text} $room", room >= if (strong) 16f else 4f)
        }
        // Inside one day: no weekday.
        val day = List(24) { at("2026-11-09T00:00:00Z") + it * 3_600_000L }
        assertTrue(axisLabels(day, "hour", List(24) { it * 800f / 23 }, 800f, 4f, measure).none { ' ' in it.text })
        assertEquals(emptySet<Int>(), hourWeekdays(day, listOf(2, 5)))
        // The tip title of an hour starts with its weekday; the current bucket keeps its header.
        assertEquals("Sun 22:00", tooltipTitle(hours[5], "hour", last = false))
        assertEquals("This hour so far", tooltipTitle(hours[23], "hour", last = true))
        assertNull(hourWeekdays(day, emptyList()).firstOrNull())
    }
}
