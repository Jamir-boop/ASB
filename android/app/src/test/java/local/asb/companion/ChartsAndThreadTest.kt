package local.asb.companion

import androidx.compose.ui.geometry.Offset
import java.time.Instant
import java.util.TimeZone
import kotlinx.coroutines.runBlocking
import local.asb.companion.data.ActivityThread
import local.asb.companion.data.MESSAGE_TEXT_OFF
import local.asb.companion.data.Metric
import local.asb.companion.data.niceStep
import local.asb.companion.data.threadQuery
import local.asb.companion.data.usageChartAxis
import local.asb.companion.net.OLDER_ENGINE
import local.asb.companion.ui.ThreadState
import local.asb.companion.ui.barDescription
import local.asb.companion.ui.chartSummary
import local.asb.companion.ui.evenAxisLabels
import local.asb.companion.ui.loadThread
import local.asb.companion.ui.stripScale
import local.asb.companion.ui.tipPlace
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

// Android council round 1, brief D: the Usage chart (headroom, even ticks, the tooltip place, TalkBack), the Messages strip scale,
// and message text in threads. Synthetic data only.
class ChartsAndThreadTest {
    private fun at(text: String) = Instant.parse(text).toEpochMilli()

    private fun utc(body: () -> Unit) {
        val zone = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
        try { body() } finally { TimeZone.setDefault(zone) }
    }

    @Test fun theTopLineLeavesEightPercentOverTheTallestBarOnRoundSteps() {
        for (max in listOf(0.004, 0.38, 0.4, 1.0, 3.7, 9.26, 10.0, 48.0, 100.0, 123_456.0, 2.5e9)) {
            val (step, lines) = usageChartAxis(max)
            assertTrue("$max: $step × $lines", step * lines >= max * 1.08 - 1e-9)
            assertTrue(lines in 3..4)
            assertEquals(niceStep(step), step, step * 1e-12)
        }
        // Without usage the axis keeps its first step.
        assertEquals(1.0 to 3, usageChartAxis(0.0))
    }

    @Test fun hourLabelsAreEvery6HoursOnTheHour() = utc {
        val measure = { text: String -> 7f * text.length }
        // Mon 17:00 to Tue 16:00: 18:00 is on the day before the last bucket, 00:00 starts Tuesday; no forced last label.
        val hours = List(24) { at("2026-11-16T17:00:00Z") + it * 3_600_000L }
        val wide = evenAxisLabels(hours, "hour", List(24) { 30f + it * 30f }, 760f, 4f, measure)
        assertEquals(listOf("Mon 18:00", "Tue 00:00", "06:00", "12:00"), wide.map { it.text })
        assertEquals(listOf(1, 7, 13, 19), wide.map { it.index })
        // Too tight for 6 hours: every 12 hours, still on the hour.
        val tight = evenAxisLabels(hours, "hour", List(24) { 2f + it * 6f }, 150f, 4f, measure)
        assertEquals(listOf("00:00", "12:00"), tight.map { it.text })
    }

    @Test fun dayLabelsNameEachDayOfSevenDays() = utc {
        val measure = { text: String -> 6.6f * text.length }
        val days = List(7) { at("2026-11-11T00:00:00Z") + it * 86_400_000L }
        val labels = evenAxisLabels(days, "day", List(7) { 70f + it * 46f }, 380f, 4f, measure)
        assertEquals(listOf("Nov 11", "Nov 12", "Nov 13", "Nov 14", "Nov 15", "Nov 16", "Nov 17"), labels.map { it.text })
        // 30 days: every 5 days from the last.
        val month = List(30) { at("2026-10-19T00:00:00Z") + it * 86_400_000L }
        assertEquals(listOf(4, 9, 14, 19, 24, 29), evenAxisLabels(month, "day", List(30) { 50f + it * 30f }, 1000f, 4f, measure).map { it.index })
    }

    @Test fun theTooltipNeverCoversItsBar() {
        // A short bar: above it.
        assertEquals(Offset(35f, 52f), tipPlace(100f, 130f, 200f, 360f, 242f, 160f, 140f, 8f))
        // A tall bar near the left: to its right; near the right: to its left.
        val right = tipPlace(60f, 90f, 10f, 360f, 242f, 160f, 140f, 8f)
        assertEquals(98f, right.x)
        val left = tipPlace(300f, 330f, 10f, 360f, 242f, 160f, 140f, 8f)
        assertEquals(132f, left.x)
        assertTrue(right.x >= 90f && left.x + 160f <= 300f)
        // No room beside a wide middle bar: above the chart.
        assertEquals(Offset(100f, -148f), tipPlace(120f, 240f, 10f, 360f, 242f, 160f, 140f, 8f))
    }

    @Test fun talkBackHearsTheChartSummaryAndEachBar() = utc {
        val hours = List(24) { at("2026-11-16T17:00:00Z") + it * 3_600_000L }
        val sums = List(24) { if (it == 21) 1.2 else .1 }
        assertEquals("Usage over time, 24 hours. Highest: 14:00, \$1.20.", chartSummary("24h", "hour", hours, sums, Metric.COST))
        assertEquals("Usage over time, 7 days. Highest: Nov 13, 2.5M.",
            chartSummary("7d", "day", List(3) { at("2026-11-11T00:00:00Z") + it * 86_400_000L }, listOf(10.0, 2.0, 2_500_000.0), Metric.TOKENS))
        assertEquals("Usage over time, 24 hours. No usage.", chartSummary("24h", "hour", hours, List(24) { 0.0 }, Metric.COST))
        assertEquals("Mon 22:00: Total \$1.20, Claude Code \$1.00, Codex \$0.20",
            barDescription("Mon 22:00", "\$1.20", listOf("Claude Code" to "\$1.00", "Codex" to "\$0.20")))
    }

    @Test fun theStripShowsItsScale() {
        assertEquals("max 48/day", stripScale(48, "day"))
        assertEquals("max 1,200/hour", stripScale(1200, "hour"))
    }

    @Test fun threadQueryFollowsThePcThreadView() {
        assertEquals(mapOf("period" to "7d", "seat" to "s1", "limit" to "100"), threadQuery("7d", "s1", null, 100))
        assertEquals(mapOf("period" to "24h", "a" to "s1", "b" to "s2", "limit" to "200"), threadQuery("24h", null, "s1" to "s2", 200))
        // A chord wins over a seat (the screen keeps only one), and no selection has no query.
        assertEquals(listOf("period", "a", "b", "limit"), threadQuery("7d", "s1", "s1" to "s2", 100)!!.keys.toList())
        assertNull(threadQuery("7d", null, null, 100))
    }

    @Test fun theOffSwitchMakesNoThreadRequest() = runBlocking {
        val noRequest: suspend () -> ActivityThread = { fail("No thread request with the switch off"); ActivityThread() }
        assertEquals(ThreadState.Off, loadThread({ false }, noRequest))
        // An older PC has no switch: the older-PC message, and no request.
        assertEquals(ThreadState.Failed(OLDER_ENGINE), loadThread({ null }, noRequest))
        assertEquals("Message text is off on the PC. Turn it on in ASB Preferences > Phone.", MESSAGE_TEXT_OFF)
    }
}
