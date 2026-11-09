package local.asb.companion

import java.util.TimeZone
import local.asb.companion.data.ActivityUsage
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Metric
import local.asb.companion.data.chartLabelShown
import local.asb.companion.data.roundArcs
import local.asb.companion.data.usageRingNote
import local.asb.companion.data.usageTokenRamp
import local.asb.companion.data.usageTotals
import local.asb.companion.ui.CACHE_SAVINGS_NOTE
import local.asb.companion.ui.USAGE_EMPTY_HINT
import local.asb.companion.ui.arcShare
import local.asb.companion.ui.axisLabels
import local.asb.companion.ui.bucketLabel
import local.asb.companion.ui.partialFirstLabel
import local.asb.companion.ui.tooltipTitle
import local.asb.companion.ui.trackStart
import local.asb.companion.ui.usageChartTitle
import local.asb.companion.ui.usageTotalsTitle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The PC round 4 Usage changes (fc1383c) and D11, All time buckets from the data span (47f612b).
class CouncilRoundFourTest {
    private fun utc(body: () -> Unit) {
        val zone = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
        try { body() } finally { TimeZone.setDefault(zone) }
    }

    private fun at(text: String) = java.time.Instant.parse(text).toEpochMilli()

    private fun assertNear(expected: List<String>, actual: List<String>) {
        assertEquals(expected.size, actual.size)
        for ((e, a) in expected.zip(actual)) for (i in listOf(1, 3, 5)) {
            val d = e.substring(i, i + 2).toInt(16) - a.substring(i, i + 2).toInt(16)
            assertTrue("$e vs $a", d in -1..1)
        }
    }

    @Test fun tokenRampChromaScalesWithLightness() {
        val keys = listOf("cacheRead", "cacheWrite", "uncached", "output")
        val ramp = { accent: String, background: String -> usageTokenRamp(accent, background).let { r -> keys.map { r.getValue(it) } } }
        assertNear(listOf("#765400", "#a27400", "#d09600", "#ffb900"), ramp("#ffb900", "#000000"))
        assertNear(listOf("#44728d", "#5890b2", "#6cb0d8", "#81d0ff"), ramp("#81d0ff", "#222226"))
        assertNear(listOf("#3e6687", "#5284ad", "#67a3d5", "#7cc4ff"), ramp("#7cc4ff", "#10141c"))
    }

    @Test fun ringCaptionsSayWhatTheFiguresInclude() {
        assertEquals("still reading", usageRingNote(true, 3, 3, false, 0, 0))
        assertEquals("without 1 unpriced model", usageRingNote(false, 3, 3, true, 10, 1))
        assertEquals("still reading · 1 of 2 machines · without 2 unpriced models",
            usageRingNote(true, 1, 2, true, 10, 2))
    }

    private val reply = AsbJson.decodeFromString<ActivityUsage>("""
        {"period":"all","buckets":{"unit":"day","startsMs":[0]},
         "machines":[{"machineId":"m1","name":"Desk","self":true,"state":"local"},{"machineId":"m2","name":"Lab","state":"online"}],
         "records":[
           {"machineId":"m1","app":"claude","model":"model-a","bucket":0,"tokens":{"uncached":1,"cacheRead":0,"cacheWrite":0,"output":0},
            "cost":{"uncached":3,"cacheRead":0,"cacheWrite":0,"output":0,"total":3,"savings":0}},
           {"machineId":"m1","app":"codex","model":"model-b","bucket":0,"tokens":{"uncached":1,"cacheRead":0,"cacheWrite":0,"output":0},
            "cost":{"uncached":1,"cacheRead":0,"cacheWrite":0,"output":0,"total":1,"savings":0}},
           {"machineId":"m2","app":"claude","model":"model-a","bucket":0,"tokens":{"uncached":1,"cacheRead":0,"cacheWrite":0,"output":0},
            "cost":{"uncached":12,"cacheRead":0,"cacheWrite":0,"output":0,"total":12,"savings":0}}]}
    """.trimIndent())

    @Test fun theTappedArcShowsItsShare() {
        val arcs = roundArcs(reply, usageTotals(reply), Metric.COST)
        val names = mapOf("m1" to "Desk", "m2" to "Lab")
        val texts = arcs.associate { (it.machineId to it.app) to arcShare(it, names) }
        assertEquals("25.0% of total", texts.getValue("m1" to null))
        assertEquals("75.0% of Desk", texts.getValue("m1" to "claude"))
        assertEquals("25.0% of Desk", texts.getValue("m1" to "codex"))
        assertEquals("75.0% of total", texts.getValue("m2" to null))
        assertEquals("100.0% of Lab", texts.getValue("m2" to "claude"))
    }

    @Test fun totalsAndChartTitlesWhileReading() {
        assertEquals("Totals (still reading)", usageTotalsTitle(true))
        assertEquals("Totals", usageTotalsTitle(false))
        assertEquals("Monthly cost (still reading)", usageChartTitle("month", cost = true, scanning = true))
        assertEquals("Daily tokens", usageChartTitle("day", cost = false, scanning = false))
        assertEquals("Hourly cost", usageChartTitle("hour", cost = true, scanning = false))
        assertEquals("Weekly cost", usageChartTitle("week", cost = true, scanning = false))
        assertEquals("Weekly tokens", usageChartTitle("week", cost = false, scanning = false))
        assertEquals("vs. uncached input price", CACHE_SAVINGS_NOTE)
    }

    @Test fun emptyHintNamesTheApps() {
        assertEquals("Usage shows here after Codex, Claude Code, OpenCode, or another agent app runs on one of your machines.", USAGE_EMPTY_HINT)
    }

    @Test fun barTrackStartsAfterAGap() {
        assertEquals(51f, trackStart(100f, .5f, 1f), 1e-6f)
        // A full bar has no track; an empty bar is all track.
        assertEquals(100f, trackStart(100f, 1f, 1f), 1e-6f)
        assertEquals(0f, trackStart(100f, 0f, 1f), 1e-6f)
        assertEquals(100f, trackStart(100f, .995f, 1f), 1e-6f)
    }

    @Test fun allTimeRepliesMayHaveFirstMs() {
        val weekly = AsbJson.decodeFromString<ActivityUsage>(
            """{"period":"all","buckets":{"unit":"week","startsMs":[1782691200000,1783296000000],"firstMs":1782907200000,"extra":1}}""")
        assertEquals(1782907200000L, weekly.buckets.firstMs)
        assertNull(AsbJson.decodeFromString<ActivityUsage>("""{"buckets":{"unit":"month","startsMs":[],"firstMs":null}}""").buckets.firstMs)
        assertNull(AsbJson.decodeFromString<ActivityUsage>("""{"buckets":{"unit":"day","startsMs":[]}}""").buckets.firstMs)
    }

    @Test fun weekLabels() = utc {
        val start = at("2026-07-13T00:00:00Z")
        assertEquals("Jul 13", bucketLabel(start, "week", last = false, short = true))
        assertEquals("This week", bucketLabel(start, "week", last = true, short = true))
        assertEquals("Week of Jul 13", bucketLabel(start, "week", last = false, short = false))
        assertEquals("Week of Jul 13", tooltipTitle(start, "week", last = false))
        assertEquals("Week of Jul 13 · so far", tooltipTitle(start, "week", last = true))
    }

    @Test fun labelSteps() {
        val shown = { count: Int, unit: String -> (0 until count).filter { chartLabelShown(count, unit, it) } }
        assertEquals((0..7).toList(), shown(8, "week"))
        assertEquals(listOf(0, 4, 8), shown(9, "week"))
        assertEquals((0 until 52).filter { (51 - it) % 4 == 0 }, shown(52, "week"))
        assertEquals(listOf(4, 12, 20, 28, 36, 44, 52), shown(53, "week"))
        assertEquals((0..6).toList(), shown(7, "day"))
        assertEquals(listOf(2, 7), shown(8, "day"))
        assertEquals(listOf(0, 5, 10, 15, 20, 25, 30), shown(31, "day"))
        assertEquals(listOf(2, 17, 32), shown(33, "day"))
        assertEquals(listOf(4, 9, 14, 19, 24, 29), shown(30, "day"))
        assertEquals(listOf(14, 29, 44, 59, 74, 89), shown(90, "day"))
    }

    // The buckets of test/fixtures/activity/usage-weekly-sample.json (PC 47f612b): 18 Monday weeks, the first record on a Wednesday.
    private val weeks = List(18) { 1782691200000L + it * 7 * 86_400_000L }
    private val FIRST = 1782907200000L

    @Test fun aPartialFirstBucketSaysFrom() = utc {
        assertEquals("From Jul 1", partialFirstLabel("week", weeks, FIRST))
        assertEquals("From Jul 16, 2024", partialFirstLabel("month", listOf(at("2024-07-01T00:00:00Z")), at("2024-07-16T10:00:00Z")))
        // The same day, no first record, or a daily chart: no partial bucket.
        assertNull(partialFirstLabel("week", weeks, weeks[0] + 3_600_000L))
        assertNull(partialFirstLabel("week", weeks, null))
        assertNull(partialFirstLabel("day", weeks, FIRST))
        assertEquals("From Jul 1", tooltipTitle(weeks[0], "week", last = false, first = "From Jul 1"))
    }

    @Test fun theFromLabelShowsWhenItFits() = utc {
        val measure = { text: String -> 7f * text.length }
        val centers = { width: Float -> List(18) { (it + .5f) * width / 18 } }
        val first = partialFirstLabel("week", weeks, FIRST)
        for (width in listOf(332f, 600f, 1000f)) {
            val labels = axisLabels(weeks, "week", centers(width), width, 4f, measure, first)
            assertEquals(0 to "From Jul 1", labels.first().index to labels.first().text)
            assertEquals(17 to "Oct 26", labels.last().index to labels.last().text)
            // No two labels overlap.
            val spans = labels.map { label ->
                val w = measure(label.text)
                val left = if (label.index == 17) width - w else centers(width)[label.index].coerceIn(w / 2, width - w / 2) - w / 2
                left to left + w
            }
            for ((a, b) in spans.zipWithNext()) assertTrue("$labels at $width", a.second <= b.first - 4f)
        }
        // Too narrow for both (70 + 4 + 42 > 100): the last label wins, and the usual labels stay.
        assertEquals(listOf(5, 17), axisLabels(weeks, "week", centers(100f), 100f, 4f, measure, first).map { it.index })
        // Without a partial bucket, the usual every-4th rule.
        assertEquals(listOf(1, 5, 9, 13, 17), axisLabels(weeks, "week", centers(1000f), 1000f, 4f, measure).map { it.index })
    }
}
