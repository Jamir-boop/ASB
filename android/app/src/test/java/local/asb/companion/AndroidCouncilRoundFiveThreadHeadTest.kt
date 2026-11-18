package local.asb.companion

import local.asb.companion.ui.anchorViewportTop
import local.asb.companion.ui.stickyHeadOffset
import local.asb.companion.ui.threadAnchor
import org.junit.Assert.assertEquals
import org.junit.Test

/** Android council round 5, brief W22 F7: the thread head stays at the viewport top while its thread is in view. */
class AndroidCouncilRoundFiveThreadHeadTest {
    @Test fun theHeadSitsInItsPlaceWhileThatPlaceIsInView() {
        assertEquals(0f, stickyHeadOffset(headTop = 120f, headHeight = 100f, threadBottom = 900f, viewportTop = 0f))
        assertEquals(0f, stickyHeadOffset(0f, 100f, 900f, 0f))
    }

    @Test fun theHeadStaysAtTheViewportTopWhileItsThreadIsInView() {
        // The page scrolled the head 400 px above the viewport top: it moves down 400 px.
        assertEquals(400f, stickyHeadOffset(-400f, 100f, 900f, 0f))
    }

    @Test fun theHeadNeverGoesPastTheThreadEnd() {
        // Only 50 px of the thread is in view: the head bottom stays at the thread end.
        assertEquals(1350f, stickyHeadOffset(-1400f, 100f, 50f, 0f))
        // The thread is off screen: the head goes with it.
        assertEquals(0f, stickyHeadOffset(-1400f, 100f, -1300f, 0f))
    }

    @Test fun showEarlierAnchorsUnderTheStuckHead() {
        // Stuck: the viewport top of the anchor is the head bottom (100), so m2 (bottom 80) under the head is not the anchor.
        val spans = listOf(Triple("m1", -200f, 10f), Triple("m2", 10f, 80f), Triple("m3", 80f, 300f))
        val top = anchorViewportTop(-400f, 100f, 900f, 0f)
        assertEquals(100f, top)
        assertEquals("m3", threadAnchor(spans, top))
        // Not stuck: the viewport top stays.
        assertEquals(0f, anchorViewportTop(120f, 100f, 900f, 0f))
    }
}
