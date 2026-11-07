package local.asb.companion

import java.time.LocalDateTime
import java.time.ZoneId
import local.asb.companion.data.chordGray
import local.asb.companion.data.contrast
import local.asb.companion.data.contrastFloor
import local.asb.companion.data.machineHue
import local.asb.companion.data.mixColor
import local.asb.companion.data.usageAxis
import local.asb.companion.ui.messageTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The PC values of the Messages and Usage council round 1 (scripts/asb-native.py).
class CouncilRoundOneTest {
    private fun fills(background: String) = (0..2).map { mixColor(background, machineHue(it), .05) }

    @Test fun chordGrayIsTheWeakestMixWithThreeToOne() {
        assertEquals(mixColor("#000000", "#ffffff", .40), chordGray("#000000", "#ffffff", fills("#000000")))
        val surfaces = listOf("#fafafa") + fills("#fafafa")
        val gray = chordGray("#fafafa", "#202020", fills("#fafafa"))
        val percent = (40..100).first { mixColor("#fafafa", "#202020", it / 100.0) == gray }
        assertTrue(percent > 40)
        assertTrue(surfaces.all { contrast(gray, it) >= 3 })
        val weaker = mixColor("#fafafa", "#202020", (percent - 1) / 100.0)
        assertFalse(surfaces.all { contrast(weaker, it) >= 3 })
    }

    @Test fun unknownAndOtherHaveThreeToOne() {
        assertTrue(contrast(contrastFloor("#5d6268", "#ffffff", "#242424", 3.0), "#242424") >= 3)
        assertEquals("#5d6268", contrastFloor("#5d6268", "#ffffff", "#000000", 3.0))
        assertTrue(contrast(contrastFloor("#5d6268", "#ffffff", "#222226", 3.0), "#222226") >= 3)
    }

    @Test fun recentTimeNamesTheDayAfterToday() {
        val zone = ZoneId.systemDefault()
        val ms = { text: String -> LocalDateTime.parse(text).atZone(zone).toInstant().toEpochMilli() }
        val now = ms("2026-10-26T16:40:00")
        assertEquals("16:28", messageTime(ms("2026-10-26T16:28:00"), now, "7d"))
        assertEquals("Sun 09:12", messageTime(ms("2026-10-25T09:12:00"), now, "7d"))
        assertEquals("Tue 09:12", messageTime(ms("2026-10-20T09:12:00"), now, "30d"))
        assertEquals("Oct 19 09:12", messageTime(ms("2026-10-19T09:12:00"), now, "30d"))
        assertEquals("23:05", messageTime(ms("2026-10-25T23:05:00"), now, "24h"))
    }

    @Test fun axisReachesTheLargestTotal() {
        assertEquals(500.0 to 4, usageAxis(1650.0))
        assertEquals(1000.0 to 3, usageAxis(2470.0))
    }
}
