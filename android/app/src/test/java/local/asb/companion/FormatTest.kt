package local.asb.companion

import local.asb.companion.ui.durationText
import local.asb.companion.ui.idleAge
import local.asb.companion.ui.spokenDuration
import local.asb.companion.ui.stateLabel
import local.asb.companion.ui.workingDuration
import org.junit.Assert.assertEquals
import org.junit.Test

class FormatTest {
    private val now = 1_800_000_000_000L

    @Test fun limitCountdownUsesTheNativeCompactFormatAndSpokenUnits() {
        val cases = listOf(
            Triple(0L, "0s", "0 seconds"),
            Triple(1L, "1s", "1 second"),
            Triple(45L, "45s", "45 seconds"),
            Triple(59L, "59s", "59 seconds"),
            Triple(60L, "1m0s", "1 minute"),
            Triple(61L, "1m1s", "1 minute 1 second"),
            Triple(122L, "2m2s", "2 minutes 2 seconds"),
            Triple(725L, "12m5s", "12 minutes 5 seconds"),
            Triple(3599L, "59m59s", "59 minutes 59 seconds"),
            Triple(3600L, "1h0m", "1 hour"),
            Triple(3601L, "1h0m", "1 hour"),
            Triple(3661L, "1h1m", "1 hour 1 minute"),
            Triple(7200L, "2h0m", "2 hours"),
            Triple(16_330L, "4h32m", "4 hours 32 minutes"),
            Triple(86_400L, "24h0m", "24 hours"),
        )
        for ((seconds, compact, spoken) in cases) {
            assertEquals("Countdown $seconds s", compact, durationText(seconds))
            assertEquals("Spoken duration $seconds s", spoken, spokenDuration(seconds))
        }
    }

    @Test fun countdownFormattingHandlesLongBoundsWithoutOverflow() {
        for (seconds in listOf(-1L, Long.MIN_VALUE)) {
            assertEquals("0s", durationText(seconds))
            assertEquals("0 seconds", spokenDuration(seconds))
        }
        assertEquals("2562047788015215h30m", durationText(Long.MAX_VALUE))
        assertEquals("2562047788015215 hours 30 minutes", spokenDuration(Long.MAX_VALUE))
    }

    @Test fun workingTimeUsesWholeSecondsAndChangesUnitsAtTheBoundary() {
        val cases = listOf(
            0L to "0s", 999L to "0s", 1000L to "1s", 45_000L to "45s",
            59_999L to "59s", 60_000L to "1m0s", 725_000L to "12m5s",
            3_599_999L to "59m59s", 3_600_000L to "1h0m", 4_320_000L to "1h12m",
            86_400_000L to "24h0m",
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
        assertEquals("2562047788015h12m", workingDuration(1, Long.MAX_VALUE))
    }

    @Test fun agesKeepRelativeUnitsIncludingLongerThanAWeek() {
        val cases = listOf(
            0L to "Just now", 59_999L to "Just now", 60_000L to "1m ago", 300_000L to "5m ago",
            3_599_999L to "59m ago", 3_600_000L to "1h ago", 10_800_000L to "3h ago",
            86_399_999L to "23h ago", 86_400_000L to "1d ago", 172_800_000L to "2d ago",
            1_209_600_000L to "14d ago",
        )
        for ((elapsed, expected) in cases) {
            assertEquals("Age $elapsed ms", expected, idleAge(now - elapsed, now))
        }
    }

    @Test fun missingAndFutureDatesAreSafeAtLongBounds() {
        for (updated in listOf(0L, -1L, Long.MIN_VALUE)) assertEquals("No date", idleAge(updated, now))
        assertEquals("Just now", idleAge(now + 1, now))
        assertEquals("Just now", idleAge(Long.MAX_VALUE, now))
        assertEquals("Just now", idleAge(1, Long.MIN_VALUE))
        assertEquals("106751991167d ago", idleAge(1, Long.MAX_VALUE))
    }

    @Test fun stateLabelsUseTheKnownStatesAndFallbackToUnknown() {
        for ((state, label) in listOf("working" to "Working", "waiting" to "Waiting", "idle" to "Idle",
            "unknown" to "Unknown", "" to "Unknown", "other" to "Unknown")) {
            assertEquals(label, stateLabel(state))
        }
    }
}
