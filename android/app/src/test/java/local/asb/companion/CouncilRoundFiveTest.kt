package local.asb.companion

import java.time.LocalDate
import java.time.ZoneId
import java.util.TimeZone
import local.asb.companion.data.ActivityBuckets
import local.asb.companion.data.ActivityMachine
import local.asb.companion.data.ActivityUsage
import local.asb.companion.data.AsbJson
import local.asb.companion.data.CostParts
import local.asb.companion.data.MACHINE_HUES
import local.asb.companion.data.Metric
import local.asb.companion.data.Palette
import local.asb.companion.data.TokenParts
import local.asb.companion.data.UsageNone
import local.asb.companion.data.UsageRecord
import local.asb.companion.data.UsageSession
import local.asb.companion.data.UsageSessions
import local.asb.companion.data.accentGuard
import local.asb.companion.data.contrast
import local.asb.companion.data.usageCostBasis
import local.asb.companion.data.usageSessions
import local.asb.companion.data.usageTotals
import local.asb.companion.ui.activityColorsOf
import local.asb.companion.ui.axisLabels
import local.asb.companion.ui.bucketProgress
import local.asb.companion.ui.hex
import local.asb.companion.ui.sessionSpoken
import local.asb.companion.ui.tooltipTitle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The PC round 5 Usage changes: D16 A hues, D17 A checked choices, the running part of the current bucket, the Totals cost basis,
// the 16 dp end gap of the axis labels, and D18 A Sessions.
class CouncilRoundFiveTest {
    private val utc = ZoneId.of("UTC")

    private fun at(text: String) = java.time.Instant.parse(text).toEpochMilli()

    private fun inUtc(body: () -> Unit) {
        val zone = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
        try { body() } finally { TimeZone.setDefault(zone) }
    }

    @Test fun machineHuesAreLighterAndDarker() {
        assertEquals(listOf("#b692c3", "#7cc48a", "#00898a", "#d6a15e", "#e38fb0", "#b4b86c"), MACHINE_HUES)
        // The one new hue that the accent guard moves: hue 0 next to a pink accent.
        assertEquals("#9a77a6", accentGuard("#b692c3", "#ffa0d8", "#222226"))
        assertEquals("#9a77a6", activityColorsOf(Palette(background = "#222226", text = "#ffffff", accent = "#ffa0d8")).hues[0].hex())
    }

    @Test fun aCheckedChoiceHasTheNeutralFillAndTheAccentLabel() {
        for ((background, text, accent, fill, ratio) in listOf(
            listOf("#000000", "#ffffff", "#ffb900", "#2b2b2b", "8.22"),
            listOf("#222226", "#ffffff", "#81d0ff", "#48484b", "5.38"),
            listOf("#10141c", "#e8eaee", "#7cc4ff", "#353840", "6.25"),
        )) {
            val colors = activityColorsOf(Palette(background = background, text = text, accent = accent))
            assertEquals(fill, colors.track.hex())
            assertEquals(accent, colors.choice.hex())
            assertEquals(ratio.toDouble(), contrast(colors.choice.hex(), fill), .02)
        }
        // An accent under 4.5:1 on the fill moves toward the text until it has 4.5:1.
        val dark = activityColorsOf(Palette(background = "#222226", text = "#ffffff", accent = "#3584e4"))
        assertTrue(contrast("#3584e4", dark.track.hex()) < 4.5)
        assertTrue(contrast(dark.choice.hex(), dark.track.hex()) >= 4.5)
    }

    @Test fun theCurrentBucketNamesItsRunningPart() {
        val hour = at("2026-10-26T16:00:00Z")
        assertEquals("minute 29 of 60", bucketProgress("hour", hour, hour + 28 * 60_000 + 59_000, utc))
        assertEquals("minute 1 of 60", bucketProgress("hour", hour, hour, utc))
        val now = at("2026-10-26T16:40:00Z")
        assertEquals("hour 17 of 24", bucketProgress("day", at("2026-10-26T00:00:00Z"), now, utc))
        assertEquals("day 1 of 7", bucketProgress("week", at("2026-10-26T00:00:00Z"), now, utc))
        assertEquals("day 7 of 7", bucketProgress("week", at("2026-10-26T00:00:00Z"), at("2026-11-01T23:59:00Z"), utc))
        assertEquals("day 26 of 31", bucketProgress("month", at("2026-10-01T00:00:00Z"), now, utc))
        assertEquals("day 3 of 28", bucketProgress("month", at("2026-02-01T00:00:00Z"), at("2026-02-03T00:00:00Z"), utc))
        // Daylight saving days in local time: 23 hours in spring, 25 in autumn.
        val berlin = ZoneId.of("Europe/Berlin")
        val spring = LocalDate.of(2026, 3, 29).atStartOfDay(berlin).toInstant().toEpochMilli()
        val autumn = LocalDate.of(2026, 10, 25).atStartOfDay(berlin).toInstant().toEpochMilli()
        assertEquals("hour 6 of 23", bucketProgress("day", spring, spring + 5 * 3_600_000L, berlin))
        assertEquals("hour 25 of 25", bucketProgress("day", autumn, autumn + 24 * 3_600_000L + 1, berlin))
    }

    private fun s(zone: String, y: Int, m: Int, d: Int) = LocalDate.of(y, m, d).atStartOfDay(ZoneId.of(zone)).toInstant().toEpochMilli()

    private fun t(zone: String, y: Int, m: Int, d: Int, h: Int, min: Int) =
        java.time.LocalDateTime.of(y, m, d, h, min).atZone(ZoneId.of(zone)).toInstant().toEpochMilli()

    @Test fun aPhoneInAnotherTimeZoneCountsThePcDays() {
        val (berlin, lima, tokyo, auckland) = listOf("Europe/Berlin", "America/Lima", "Asia/Tokyo", "Pacific/Auckland")
        val berlinNow = t(berlin, 2026, 10, 26, 16, 40)
        assertEquals("day 26 of 31", bucketProgress("month", s(berlin, 2026, 10, 1), berlinNow, ZoneId.of(lima)))
        assertEquals("day 1 of 7", bucketProgress("week", s(berlin, 2026, 10, 26), berlinNow, ZoneId.of(lima)))
        assertEquals("hour 17 of 24", bucketProgress("day", s(berlin, 2026, 10, 26), berlinNow, ZoneId.of(lima)))
        assertEquals("day 26 of 31", bucketProgress("month", s(lima, 2026, 10, 1), t(lima, 2026, 10, 26, 16, 40), ZoneId.of(tokyo)))
        assertEquals("day 7 of 7", bucketProgress("week", s(lima, 2026, 10, 26), t(lima, 2026, 11, 1, 23, 59), ZoneId.of(tokyo)))
        assertEquals("day 3 of 28", bucketProgress("month", s(lima, 2026, 2, 1), t(lima, 2026, 2, 3, 0, 0), ZoneId.of(auckland)))
        assertEquals("day 1 of 31", bucketProgress("month", s(auckland, 2026, 10, 1), t(auckland, 2026, 10, 1, 0, 1), ZoneId.of(lima)))
        assertEquals("day 31 of 31", bucketProgress("month", s(auckland, 2026, 10, 1), t(auckland, 2026, 10, 31, 23, 59), ZoneId.of(lima)))
        assertEquals("hour 17 of 24", bucketProgress("day", s(lima, 2026, 10, 26), t(lima, 2026, 10, 26, 16, 40), ZoneId.of(tokyo)))
    }

    @Test fun theLastTooltipTitleIsTheHeader() = inUtc {
        val now = at("2026-10-26T16:40:00Z")
        assertEquals("This hour so far · minute 41 of 60", tooltipTitle(at("2026-10-26T16:00:00Z"), "hour", last = true, nowMs = now))
        assertEquals("Today so far · hour 17 of 24", tooltipTitle(at("2026-10-26T00:00:00Z"), "day", last = true, nowMs = now))
        assertEquals("This week so far · day 1 of 7", tooltipTitle(at("2026-10-26T00:00:00Z"), "week", last = true, nowMs = now))
        assertEquals("This month so far · day 26 of 31", tooltipTitle(at("2026-10-01T00:00:00Z"), "month", last = true, nowMs = now))
        // The partial first bucket that is also the last one takes the header too.
        assertEquals("This week so far · day 1 of 7",
            tooltipTitle(at("2026-10-26T00:00:00Z"), "week", last = true, first = "From Oct 26", nowMs = now))
        // Other buckets keep their names.
        assertEquals("Week of Oct 19", tooltipTitle(at("2026-10-19T00:00:00Z"), "week", last = false, nowMs = now))
        assertEquals("From Oct 20", tooltipTitle(at("2026-10-19T00:00:00Z"), "week", last = false, first = "From Oct 20", nowMs = now))
    }

    @Test fun aRegularLabelKeepsTheEndGapFromAnEndLabel() = inUtc {
        // 7 px per character: `Oct 5` is 35 px, the others 42 px; the last label ends at the right edge.
        val starts = listOf(5, 12, 19, 26).map { at("2026-10-%02dT00:00:00Z".format(it)) }
        val measure = { text: String -> 7f * text.length }
        // `Oct 19` ends 10 px before `Oct 26`: kept with a 4 px gap, dropped with the 16 px end gap.
        val centers = listOf(21f, 100f, 167f, 240f)
        assertEquals(listOf(0, 1, 2, 3), axisLabels(starts, "week", centers, 240f, 4f, measure, endGap = 4f).map { it.index })
        assertEquals(listOf(0, 1, 3), axisLabels(starts, "week", centers, 240f, 4f, measure, endGap = 16f).map { it.index })
        // A kept `From` label is an end label too: `Oct 19` starts 13 px after it, so it goes with the 16 px end gap.
        val partial = listOf(0f, 60f, 104f, 240f)
        assertEquals(listOf(0, 2, 3), axisLabels(starts, "week", partial, 240f, 4f, measure, "From Oct 1", endGap = 4f).map { it.index })
        assertEquals(listOf(0, 3), axisLabels(starts, "week", partial, 240f, 4f, measure, "From Oct 1", endGap = 16f).map { it.index })
    }

    private fun record(machineId: String, tokens: Long, cost: Double?) = UsageRecord(machineId, "codex", "model-a", "", 0,
        TokenParts(uncached = tokens), cost?.let { CostParts(uncached = it, total = it) })

    @Test fun theCostBasisNamesTheUnpricedModels() {
        val reply = ActivityUsage(buckets = ActivityBuckets("day", listOf(0L)), machines = listOf(ActivityMachine("m1", "Desk")),
            records = listOf(record("m1", 10, 1.0)))
        assertEquals("if paid at API prices", usageCostBasis(usageTotals(reply)))
        val one = reply.copy(records = reply.records + record("m1", 5, null))
        assertEquals("if paid at API prices · without 1 unpriced model", usageCostBasis(usageTotals(one)))
        val three = one.copy(records = one.records + listOf("model-b", "model-c").map { record("m1", 5, null).copy(model = it) })
        assertEquals("if paid at API prices · without 3 unpriced models", usageCostBasis(usageTotals(three)))
    }

    // Made-up sessions: Desk has 12 (cost 1..12, tokens 1200..100) and 500 tokens with no session, Lab 6 (cost 0.5j + 0.25, tokens
    // 1000j), Box 2 and 300 tokens with no session; Spare has usage and no session.
    private val desk = (1..12).map { UsageSession("m1", "d$it", "claude", "Desk task $it", TokenParts(output = (13 - it) * 100L), it.toDouble()) }
    private val lab = (1..6).map { UsageSession("m2", "l$it", "codex", "Lab task $it", TokenParts(cacheRead = it * 1000L), .5 * it + .25) }
    private val box = (1..2).map { UsageSession("m3", "b$it", "opencode", "Box task $it", TokenParts(uncached = it * 10L), it * .125) }
    private val sessions = UsageSessions(desk + lab + box, mapOf("m1" to 12, "m2" to 6, "m3" to 2),
        mapOf("m1" to UsageNone(TokenParts(uncached = 500), 2.0), "m3" to UsageNone(TokenParts(uncached = 300), .5)))
    private val reply = ActivityUsage(
        buckets = ActivityBuckets("day", listOf(0L)),
        machines = listOf(ActivityMachine("m1", "Desk"), ActivityMachine("m2", "Lab"), ActivityMachine("m3", "Box"), ActivityMachine("m4", "Spare")),
        records = listOf(record("m1", desk.sumOf { it.tokens.processed } + 500, desk.sumOf { it.cost } + 2),
            record("m2", lab.sumOf { it.tokens.processed }, lab.sumOf { it.cost }),
            record("m3", box.sumOf { it.tokens.processed } + 300, box.sumOf { it.cost } + .5),
            record("m4", 700, 3.0)),
        sessions = sessions,
    )

    @Test fun theTopEightSessionsByCostAndByTokens() {
        val totals = usageTotals(reply, setOf("m3", "m4"))
        val cost = usageSessions(reply, totals, Metric.COST)!!
        assertEquals((12 downTo 5).map { "d$it" }, cost.rows.map { it.id })
        val tokens = usageSessions(reply, totals, Metric.TOKENS)!!
        assertEquals(listOf("l6", "l5", "l4", "l3", "l2", "d1", "d2", "d3"), tokens.rows.map { it.id })
        // 18 sessions on Desk and Lab, 8 shown.
        assertEquals("Other sessions (10)", cost.other!!.label)
        assertEquals("Other sessions (10)", tokens.other!!.label)
        assertEquals(12.0 / totals.cost, cost.rows[0].share, 1e-12)
    }

    @Test fun theRowsAndTheRestAddUpToTheTotals() {
        for (off in listOf(emptySet(), setOf("m4"), setOf("m3", "m4"), setOf("m1"))) for (metric in Metric.entries) {
            val totals = usageTotals(reply, off)
            val view = usageSessions(reply, totals, metric)!!
            val other = view.other!!
            assertEquals(totals.cost, view.rows.sumOf { it.cost } + other.cost, 1e-6)
            assertEquals(totals.tokens, view.rows.sumOf { it.tokens } + other.tokens)
        }
        assertEquals("Other sessions (12)", usageSessions(reply, usageTotals(reply), Metric.COST)!!.other!!.label)
    }

    @Test fun theRestRowShowsOnlyWithMoreSessionsOrUsageWithNoSession() {
        // Lab alone: all 6 sessions show and it has no usage without a session.
        val lab = usageSessions(reply, usageTotals(reply, setOf("m1", "m3", "m4")), Metric.COST)!!
        assertEquals(6, lab.rows.size)
        assertNull(lab.other)
        // Box alone: 2 sessions and 300 tokens with no session.
        for (metric in Metric.entries) {
            val box = usageSessions(reply, usageTotals(reply, setOf("m1", "m2", "m4")), metric)!!
            assertEquals(listOf("b2", "b1"), box.rows.map { it.id })
            assertEquals("Usage with no session", box.other!!.label)
        }
    }

    @Test fun noSessionsNoSection() {
        val totals = usageTotals(reply)
        assertNull(usageSessions(reply.copy(sessions = null), totals, Metric.COST))
        assertNull(usageSessions(reply.copy(sessions = UsageSessions()), totals, Metric.COST))
        // Spare alone has usage and no session.
        assertNull(usageSessions(reply, usageTotals(reply, setOf("m1", "m2", "m3")), Metric.TOKENS))
        assertNotNull(usageSessions(reply, totals, Metric.TOKENS))
    }

    @Test fun tiesGoToTheTitleThenTheId() {
        val tied = listOf(UsageSession("m1", "z", "codex", "Beta", TokenParts(output = 5), 1.0),
            UsageSession("m1", "y", "codex", "Alpha", TokenParts(output = 5), 1.0),
            UsageSession("m1", "x", "codex", "Beta", TokenParts(output = 5), 1.0))
        val small = ActivityUsage(buckets = ActivityBuckets("day", listOf(0L)), machines = listOf(ActivityMachine("m1", "Desk")),
            records = listOf(record("m1", 15, 3.0)), sessions = UsageSessions(tied, mapOf("m1" to 3)))
        for (metric in Metric.entries) {
            val view = usageSessions(small, usageTotals(small), metric)!!
            assertEquals(listOf("y", "x", "z"), view.rows.map { it.id })
            assertNull(view.other)
        }
    }

    @Test fun repliesParseWithAndWithoutSessions() {
        val without = AsbJson.decodeFromString<ActivityUsage>("""{"period":"7d","buckets":{"unit":"day","startsMs":[0]}}""")
        assertNull(without.sessions)
        val with = AsbJson.decodeFromString<ActivityUsage>("""
            {"period":"7d","buckets":{"unit":"day","startsMs":[0]},
             "sessions":{"rows":[{"machineId":"m1","id":"s1","app":"codex","title":"Fix the tests",
               "tokens":{"uncached":1,"cacheRead":2,"cacheWrite":3,"output":4},"cost":0,"unpriced":true,"extra":1},
               {"machineId":"m1","id":"s2","app":"claude","title":"Unlisted session","tokens":{"uncached":5,"cacheRead":0,"cacheWrite":0,"output":0},"cost":0.5}],
              "counts":{"m1":2},"none":{"m1":{"tokens":{"uncached":7,"cacheRead":0,"cacheWrite":0,"output":0},"cost":0.01}},"later":true}}
        """.trimIndent())
        val parsed = with.sessions!!
        assertEquals(10L, parsed.rows[0].tokens.processed)
        assertTrue(parsed.rows[0].unpriced)
        assertEquals(false, parsed.rows[1].unpriced)
        assertEquals(.5, parsed.rows[1].cost, 0.0)
        assertEquals(mapOf("m1" to 2), parsed.counts)
        assertEquals(7L, parsed.none.getValue("m1").tokens.processed)
        assertEquals(UsageSessions(), AsbJson.decodeFromString<UsageSessions>("{}"))
    }

    @Test fun eachSessionRowReadsAsOneSentence() {
        assertEquals("Fix the build, Codex, Desk, $12.00, 25.0% of the cost", sessionSpoken("Fix the build", "Codex", "Desk", "$12.00", .25, Metric.COST))
        assertEquals("Other sessions (10), 1.2M, 40.0% of the tokens", sessionSpoken("Other sessions (10)", null, null, "1.2M", .4, Metric.TOKENS))
    }
}
