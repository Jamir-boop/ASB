package local.asb.companion

import androidx.compose.ui.text.style.TextOverflow
import java.time.Instant
import java.util.TimeZone
import local.asb.companion.data.ActivityMachine
import local.asb.companion.data.ActivityMessage
import local.asb.companion.data.ActivityThread
import local.asb.companion.data.THREAD_FEWER
import local.asb.companion.data.THREAD_LIMIT
import local.asb.companion.data.THREAD_MAX
import local.asb.companion.data.threadQuery
import local.asb.companion.net.OLDER_ENGINE
import local.asb.companion.ui.BarGeom
import local.asb.companion.ui.NAME_OVERFLOW
import local.asb.companion.ui.THREAD_TOO_LONG
import local.asb.companion.ui.ThreadState
import local.asb.companion.ui.barDescription
import local.asb.companion.ui.errorCopy
import local.asb.companion.ui.formatDateYear
import local.asb.companion.ui.hourText
import local.asb.companion.ui.loadThread
import local.asb.companion.ui.machineStateLine
import local.asb.companion.ui.messageMaxLines
import local.asb.companion.ui.polledThread
import local.asb.companion.ui.threadCountText
import local.asb.companion.ui.tipPlace
import local.asb.companion.ui.tooltipTitle
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Android council round 2, brief W3: the Usage chart taps and nodes, the tooltip place, the so-far bucket, the seen year, the
// thread clamp and next steps, and the message text switch. Synthetic data only.
class AndroidCouncilRoundTwoChartsTest {
    private fun at(text: String) = Instant.parse(text).toEpochMilli()

    private fun utc(body: () -> Unit) {
        val zone = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
        try { body() } finally { TimeZone.setDefault(zone) }
    }

    // The e96 phone: 2.81 px per dp; a 1001 px chart with a 48 dp axis room and 2 dp gaps (24 bars of about 13 dp).
    private val dp = 2.81f
    private val geom = BarGeom(left = 48 * dp, width = 1001f, n = 24, gap = 2 * dp)

    @Test fun eachBarCenterNodeAndTapHaveOneIndex() {
        for (i in 0 until 24) {
            val center = geom.center(i)
            assertEquals(i, geom.indexAt(center))
            val (x0, x1) = geom.column(i)
            assertTrue("node $i holds the center of bar $i", center > x0 && center < x1)
            // The node center is the bar center, so a tap at the node center selects that bar.
            assertEquals(i, geom.indexAt((x0 + x1) / 2))
            // The columns tile the plot: each is one slot wide and starts where the one before ends.
            assertEquals(geom.slot, x1 - x0, 1e-3f)
            if (i > 0) assertEquals(geom.column(i - 1).second, x0, 1e-3f)
            // A tap in the gap after a bar picks the nearest bar center.
            val gapMiddle = geom.barLeft(i) + geom.bar + geom.gap / 2
            if (i < 23) assertTrue(geom.indexAt(gapMiddle - .1f) == i && geom.indexAt(gapMiddle + .1f) == i + 1)
        }
        assertNull(geom.indexAt(10f))
        assertNull(geom.indexAt(1002f))
        // A bar under 48 dp wide gets the full slot as its touch area.
        assertTrue(geom.bar < 48 * dp && geom.slot > geom.bar)
    }

    @Test fun theNodeAndTheTapOfEighteenSelectTheEighteenBar() = utc {
        // e96: 24 hours from Mon 22:00; the node with "Tue 18:00" is bar 20, and a tap at its center selects bar 20, not 19.
        val starts = List(24) { at("2026-11-16T22:00:00Z") + it * 3_600_000L }
        val i = starts.indexOfFirst { hourText(it, weekday = true) == "Tue 18:00" }
        assertEquals(20, i)
        val (x0, x1) = geom.column(i)
        assertEquals(i, geom.indexAt((x0 + x1) / 2))
        assertTrue(barDescription(tooltipTitle(starts[i], "hour", false), "\$0.61", emptyList()).startsWith("Tue 18:00:"))
    }

    @Test fun theTooltipIsThePcBoxInsideTheChart() {
        // The PC box, 160 by 120, in a 300 dp tall chart: above a short middle bar, beside a tall one on the side with more room.
        val height = 300f * dp
        val i = 12
        val above = tipPlace(geom.barLeft(i), geom.barLeft(i) + geom.bar, height - 20f, geom.width, height, 160f, 120f, 8 * dp)
        assertEquals(height - 20f - 8 * dp - 120f, above.y)
        assertEquals(geom.center(i) - 80f, above.x, 1e-3f)
        for (j in 0 until 24) {
            val tip = tipPlace(geom.barLeft(j), geom.barLeft(j) + geom.bar, 10f, geom.width, height, 160f, 120f, 8 * dp)
            // Beside a tall bar: never over its column, and inside the chart.
            assertTrue(tip.x + 160f <= geom.barLeft(j) || tip.x >= geom.barLeft(j) + geom.bar)
            assertTrue(tip.x >= 0f && tip.x + 160f <= geom.width && tip.y >= 0f && tip.y + 120f <= height)
            // Left of the bar for the right half, so a box near the end does not cover the last buckets.
            if (j >= 22) assertTrue(tip.x + 160f <= geom.barLeft(j))
        }
    }

    @Test fun theCurrentBucketSaysSoFar() = utc {
        val start = at("2026-11-17T00:00:00Z")
        val title = tooltipTitle(start, "day", last = true, nowMs = at("2026-11-17T20:30:00Z"))
        assertEquals("Today so far · hour 21 of 24", title)
        assertTrue(barDescription(title, "\$1.20", emptyList()).contains("so far"))
        assertFalse(tooltipTitle(start, "day", last = false).contains("so far"))
    }

    @Test fun aSeenDateOfAnEarlierYearShowsTheYear() = utc {
        val now = at("2026-11-17T12:00:00Z")
        assertEquals("Oct 12, 2025", formatDateYear(at("2025-10-12T09:00:00Z"), now))
        assertEquals("Oct 12", formatDateYear(at("2026-10-12T09:00:00Z"), now))
        assertEquals("Offline · seen Oct 12, 2025, 09:00",
            machineStateLine(ActivityMachine(state = "offline", lastReportAtMs = at("2025-10-12T09:00:00Z")), now))
        assertEquals("Offline · seen Oct 25, 14:30",
            machineStateLine(ActivityMachine(state = "offline", lastReportAtMs = at("2026-10-25T14:30:00Z")), now))
    }

    @Test fun aMessageShowsSixLinesUntilShowMore() {
        assertEquals(6, messageMaxLines(expanded = false))
        assertEquals(Int.MAX_VALUE, messageMaxLines(expanded = true))
    }

    @Test fun sessionNamesAreCutAtTheEnd() {
        assertEquals(TextOverflow.Ellipsis, NAME_OVERFLOW)
    }

    @Test fun aPollWithTheSwitchOffHoldsNoText() {
        val shown = ThreadState.Shown(ActivityThread(1, listOf(ActivityMessage(id = "m1", text = "synthetic text"))))
        val after = polledThread(shown, textOn = false)
        assertEquals(ThreadState.Off, after)
        assertFalse(after.toString().contains("synthetic text"))
        assertEquals(shown, polledThread(shown, textOn = true))
        assertEquals(shown, polledThread(shown, textOn = null))
    }

    @Test fun aTooLargeThreadOffersFewerMessages() = runBlocking {
        val tooLarge = loadThread({ true }) { throw local.asb.companion.net.AsbError.Server("The ASB reply is too large.") }
        assertEquals(ThreadState.TooLong, tooLarge)
        assertEquals("This thread is too long to load.", THREAD_TOO_LONG)
        assertEquals(50, THREAD_FEWER)
        assertEquals("50", threadQuery("7d", "a", null, THREAD_FEWER)!!["limit"])
    }

    @Test fun theOlderPcHasNoRetryAndNamesItsScreen() {
        val messages = errorCopy(OLDER_ENGINE, "messages")
        assertEquals("Update ASB on the PC to see messages.", messages.sentence)
        assertFalse(messages.retry)
        assertEquals("Update ASB on the PC to see usage.", errorCopy(OLDER_ENGINE, "usage").sentence)
        assertEquals("Update ASB on the PC to see All time.",
            errorCopy("This PC runs an older ASB. Update ASB on the PC to see All time.", "usage").sentence)
        assertTrue(errorCopy("Could not reach ASB. Check the PC and Wi-Fi, then try again.", "usage").retry)
    }

    @Test fun theCutThreadSaysWhereTheRestIs() {
        assertEquals("Newest 100 of 230", threadCountText(100, 230, THREAD_LIMIT))
        assertEquals("Newest 200 of 230. The PC thread view shows all.", threadCountText(200, 230, THREAD_MAX))
    }
}
