package local.asb.companion

import local.asb.companion.data.Thread
import local.asb.companion.notify.liveLines
import local.asb.companion.notify.liveText
import local.asb.companion.notify.liveTitle
import org.junit.Assert.assertEquals
import org.junit.Test

/** Android council round 5, brief W22 F5: the Live group lines, their text, and the title. */
class AndroidCouncilRoundFiveNotifyTest {
    private fun r(id: String, state: String = "idle", pending: Boolean = false, at: Long = 0) =
        Thread(id = id, state = state, pending = pending, title = id, updatedAtMs = at)

    private val pending = (1..25).map { r("p$it", pending = true, at = 100L - it) }
    private val working = (1..13).map { r("w$it", "working") }

    @Test fun bothGroupsWithBothOverflows() {
        val lines = liveLines(pending + working)
        assertEquals(listOf("Pending: p1, p2, p3, +22 more", "Working: w1, w2, +11 more"), lines)
        assertEquals("Pending: p1, p2, p3, +22 more · Working: w1, w2, +11 more", liveText(lines))
    }

    @Test fun onlyPending() {
        assertEquals(listOf("Pending: p1, p2"), liveLines(pending.take(2)))
        assertEquals("Pending: p1, p2", liveText(liveLines(pending.take(2))))
    }

    @Test fun onlyWorking() {
        assertEquals(listOf("Working: w1, w2, w3, w4, w5, w6, +7 more"), liveLines(working))
    }

    @Test fun aPendingWorkingRowIsCountedOnceWithPending() {
        assertEquals(listOf("Pending: both", "Working: w1"), liveLines(listOf(r("w1", "working"), r("both", "working", pending = true))))
    }

    @Test fun noRows() {
        assertEquals(listOf("No session is working."), liveLines(listOf(r("i1"))))
        assertEquals("No session is working.", liveText(liveLines(emptyList())))
    }

    @Test fun theTitleLeavesOutAZeroPart() {
        assertEquals("13 pending", liveTitle(pending.take(13)))
        assertEquals("2 working", liveTitle(working.take(2)))
        assertEquals("8 pending · 2 working", liveTitle(pending.take(8) + working.take(2)))
        assertEquals("0 pending · 0 working", liveTitle(listOf(r("i1"))))
    }
}
