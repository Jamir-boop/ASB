package local.asb.companion

import local.asb.companion.ui.cardFontScale
import local.asb.companion.ui.comfortableCardHeight
import local.asb.companion.ui.pinchStep
import local.asb.companion.ui.zoomBadgeDescription
import local.asb.companion.ui.zoomBadgeText
import local.asb.companion.ui.zoomLevel
import local.asb.companion.ui.zoomStep
import org.junit.Assert.assertEquals
import org.junit.Test

class CardZoomTest {
    @Test fun zoomStepMovesOneLevelAndClamps() {
        assertEquals(110, zoomStep(100, 1))
        assertEquals(90, zoomStep(100, -1))
        assertEquals(150, zoomStep(110, 2))
        assertEquals(200, zoomStep(200, 1))
        assertEquals(200, zoomStep(175, 5))
        assertEquals(80, zoomStep(80, -1))
        assertEquals(80, zoomStep(90, -4))
    }

    @Test fun anUnknownZoomGoesTo100() {
        assertEquals(100, zoomLevel(105))
        assertEquals(100, zoomLevel(0))
        assertEquals(125, zoomLevel(125))
        assertEquals(110, zoomStep(105, 1))
        assertEquals(100, zoomStep(-3, 0))
    }

    @Test fun pinchStepsOnceForEach115() {
        assertEquals(1, pinchStep(1f, 1.15f).first)
        assertEquals(2, pinchStep(1f, 1.4f).first)
        assertEquals(-1, pinchStep(1f, 1 / 1.15f).first)
        assertEquals(-2, pinchStep(1f, 1 / 1.4f).first)
    }

    @Test fun pinchAccumulatesAcrossEvents() {
        var factor = 1f
        var steps = 0
        repeat(10) { val (step, rest) = pinchStep(factor, 1.035f); steps += step; factor = rest }
        // 1.035^10 is about 1.41: two steps.
        assertEquals(2, steps)
    }

    @Test fun smallJitterDoesNotStep() {
        var factor = 1f
        var steps = 0
        repeat(50) { i ->
            val (step, rest) = pinchStep(factor, if (i % 2 == 0) 1.05f else 1 / 1.05f)
            steps += step
            factor = rest
        }
        assertEquals(0, steps)
        assertEquals(0, pinchStep(1f, 1.1f).first)
        assertEquals(0, pinchStep(1f, .9f).first)
    }

    @Test fun aDegenerateChangeDoesNotStep() {
        assertEquals(0 to 1.2f, pinchStep(1.2f, 0f))
        assertEquals(0 to 1.2f, pinchStep(1.2f, Float.POSITIVE_INFINITY))
        assertEquals(0 to 1.2f, pinchStep(1.2f, Float.NaN))
    }

    @Test fun badgeTextAndDescription() {
        assertEquals("125%", zoomBadgeText(125))
        assertEquals("Zoom 125%. Reset zoom.", zoomBadgeDescription(125))
        assertEquals("Zoom 80%. Reset zoom.", zoomBadgeDescription(80))
    }

    @Test fun zoomIsAFactorOnTheCardScale() {
        assertEquals(1.5f * 1.15f * 1.25f, cardFontScale(1.5f, 1.15f, 125), .001f)
        assertEquals(.8f, cardFontScale(1f, 1f, 80), .001f)
        assertEquals(cardFontScale(1.3f, .85f), cardFontScale(1.3f, .85f, 100), .001f)
        assertEquals(comfortableCardHeight(2f), comfortableCardHeight(cardFontScale(1f, 1f, 200)), .001f)
    }
}
