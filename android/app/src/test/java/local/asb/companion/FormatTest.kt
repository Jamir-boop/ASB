package local.asb.companion

import local.asb.companion.ui.idleAge
import local.asb.companion.ui.stateLabel
import local.asb.companion.ui.workingDuration
import org.junit.Assert.assertEquals
import org.junit.Test

class FormatTest {
    private val now = 1_800_000_000_000L

    @Test fun workingTimeUsesWholeSecondsAndChangesUnitsAtTheBoundary() {
        val cases = listOf(
            0L to "0s", 999L to "0s", 1000L to "1s", 45_000L to "45s",
            59_999L to "59s", 60_000L to "1m 00s", 725_000L to "12m 05s",
            3_599_999L to "59m 59s", 3_600_000L to "1h 0m", 4_320_000L to "1h 12m",
            86_400_000L to "24h 0m",
        )
        for ((elapsed, expected) in cases) {
            assertEquals("Elapsed $elapsed ms", expected, workingDuration(now - elapsed, now))
        }
    }

    @Test fun anUnknownOrFutureStartDoesNotInventAWorkingTimer() {
        for (start in listOf(0L, -1L, Long.MIN_VALUE, now + 1, Long.MAX_VALUE)) {
            assertEquals("Start $start", "", workingDuration(start, now))
        }
        assertEquals("", workingDuration(1, Long.MIN_VALUE))
        assertEquals("2562047788015h 12m", workingDuration(1, Long.MAX_VALUE))
    }

    @Test fun agesKeepRelativeUnitsIncludingLongerThanAWeek() {
        val cases = listOf(
            0L to "now", 59_999L to "now", 60_000L to "1m", 300_000L to "5m",
            3_599_999L to "59m", 3_600_000L to "1h", 10_800_000L to "3h",
            86_399_999L to "23h", 86_400_000L to "1d", 172_800_000L to "2d",
            1_209_600_000L to "14d",
        )
        for ((elapsed, expected) in cases) {
            assertEquals("Age $elapsed ms", expected, idleAge(now - elapsed, now))
        }
    }

    @Test fun missingAndFutureDatesAreSafeAtLongBounds() {
        for (updated in listOf(0L, -1L, Long.MIN_VALUE)) assertEquals("No date", idleAge(updated, now))
        assertEquals("now", idleAge(now + 1, now))
        assertEquals("now", idleAge(Long.MAX_VALUE, now))
        assertEquals("now", idleAge(1, Long.MIN_VALUE))
        assertEquals("106751991167d", idleAge(1, Long.MAX_VALUE))
    }

    @Test fun stateLabelsUseTheKnownStatesAndFallbackToUnknown() {
        for ((state, label) in listOf("working" to "Working", "waiting" to "Waiting", "idle" to "Idle",
            "unknown" to "Unknown", "" to "Unknown", "other" to "Unknown")) {
            assertEquals(label, stateLabel(state))
        }
    }
}
