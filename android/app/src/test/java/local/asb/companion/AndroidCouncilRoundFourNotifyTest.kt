package local.asb.companion

import local.asb.companion.data.Palette
import local.asb.companion.data.Thread
import local.asb.companion.data.contrast
import local.asb.companion.notify.ABOUT_LIVE
import local.asb.companion.notify.liveLines
import local.asb.companion.ui.hex
import local.asb.companion.ui.switchStyle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Android council round 4, brief W19: the Live caption, the pending rest count, and the switch style. */
class AndroidCouncilRoundFourNotifyTest {
    @Test fun theLiveCaptionIsThreeSentencesWithNoPollTimes() {
        assertEquals("Shows the Pending and Working counts. Alerts come within seconds while it is on. " +
            "Without it, Android checks about every 15 minutes.", ABOUT_LIVE)
    }

    private fun r(id: String, state: String = "idle", pending: Boolean = false, at: Long = 0) =
        Thread(id = id, state = state, pending = pending, title = "Task $id", updatedAtMs = at)

    @Test fun morePendingRowsThanThreeEndInARestCount() {
        val pending = (1..13).map { r("p$it", pending = true, at = 100L - it) }
        assertEquals(listOf("Pending: Task p1, Task p2, Task p3, +10 more", "Working: Task w1"),
            liveLines(pending + r("w1", "working")))
        // Three pending rows have no rest count; a working row past the first 3 pending is in the rest count, not listed.
        assertEquals(listOf("Pending: Task p1, Task p2, Task p3"), liveLines(pending.take(3)))
        assertEquals(listOf("Pending: Task p1, Task p2, Task p3, +1 more"),
            liveLines(pending.take(3) + r("p4", "working", pending = true, at = 0)))
        // The working titles still end in +N more after the 6 lines.
        val working = (1..5).map { r("w$it", "working") }
        assertEquals(listOf("Pending: Task p1, Task p2, Task p3, +10 more", "Working: Task w1, Task w2, +3 more"),
            liveLines(pending + working))
    }

    @Test fun anOffSwitchHasThreeToOneOnItsSurface() {
        val palette = Palette()
        val style = switchStyle(palette)
        assertEquals(palette.background, style.uncheckedTrack.hex())
        assertTrue(contrast(style.uncheckedBorder.hex(), palette.background) >= 3.0)
        assertTrue(contrast(style.uncheckedThumb.hex(), palette.background) >= 3.0)
        assertEquals(palette.accent, style.checkedTrack.hex())
        // A lighter card surface gets its own 3:1 edge.
        val card = "#2e2e33"
        assertTrue(contrast(switchStyle(palette, card).uncheckedBorder.hex(), card) >= 3.0)
    }
}
