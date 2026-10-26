package local.asb.companion

import java.time.Instant
import java.util.Locale
import java.util.TimeZone
import local.asb.companion.data.ActivityMachine
import local.asb.companion.data.Thread
import local.asb.companion.data.UsagePrices
import local.asb.companion.data.UsageScan
import local.asb.companion.ui.bucketLabel
import local.asb.companion.ui.dayText
import local.asb.companion.ui.formatCost
import local.asb.companion.ui.formatCount
import local.asb.companion.ui.formatDate
import local.asb.companion.ui.formatShare
import local.asb.companion.ui.formatTime
import local.asb.companion.ui.formatTokens
import local.asb.companion.ui.lastReportText
import local.asb.companion.ui.machineStateLine
import local.asb.companion.ui.machineStateText
import local.asb.companion.ui.pricesText
import local.asb.companion.ui.scanText
import local.asb.companion.ui.cardStateLabel
import local.asb.companion.ui.connectionText
import local.asb.companion.ui.durationText
import local.asb.companion.ui.engineLine
import local.asb.companion.ui.idleAge
import local.asb.companion.ui.limitText
import local.asb.companion.ui.searchOpen
import local.asb.companion.ui.spokenDuration
import local.asb.companion.ui.spokenLimit
import local.asb.companion.ui.stateLabel
import local.asb.companion.ui.workingDuration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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

    // Values from limit_text and spoken_limit in scripts/asb-native.py.
    @Test fun limitCountdownShowsDaysAndHoursFrom24Hours() {
        val cases = listOf(
            Triple(0L, "0s", "0 seconds"),
            Triple(45L, "45s", "45 seconds"),
            Triple(725L, "12m5s", "12 minutes 5 seconds"),
            Triple(3600L, "1h0m", "1 hour"),
            Triple(16_330L, "4h32m", "4 hours 32 minutes"),
            Triple(86_399L, "23h59m", "23 hours 59 minutes"),
            Triple(86_400L, "1d0h", "1 day"),
            Triple(90_000L, "1d1h", "1 day 1 hour"),
            Triple(176_399L, "2d0h", "2 days"),
            Triple(273_600L, "3d4h", "3 days 4 hours"),
            Triple(604_800L, "7d0h", "7 days"),
        )
        for ((seconds, compact, spoken) in cases) {
            assertEquals("Limit $seconds s", compact, limitText(seconds))
            assertEquals("Spoken limit $seconds s", spoken, spokenLimit(seconds))
        }
        assertEquals("0s", limitText(-1))
        // The Working timer keeps its format.
        assertEquals("76h0m", workingDuration(now - 273_600_000, now))
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

    @Test fun cardStateSaysStoppedOnlyForAnIdleFailedOrLimitStop() {
        assertEquals("Stopped", cardStateLabel(Thread(state = "idle", lastOutcome = "failed")))
        assertEquals("Stopped", cardStateLabel(Thread(state = "idle", lastOutcome = "limit")))
        assertEquals("Idle", cardStateLabel(Thread(state = "idle", lastOutcome = "stopped")))
        assertEquals("Idle", cardStateLabel(Thread(state = "idle", lastOutcome = "")))
        assertEquals("Working", cardStateLabel(Thread(state = "working", lastOutcome = "failed")))
        assertEquals("Idle", stateLabel("idle"))
    }

    @Test fun connectionTextShowsServerStateAndOnlyALivePath() {
        assertEquals("PC · Live · Home network", connectionText("PC", offline = false, pathLabel = "Home network"))
        assertEquals("PC · Live · ZeroTier", connectionText("PC", offline = false, pathLabel = "ZeroTier"))
        assertEquals("PC · Live", connectionText("PC", offline = false, pathLabel = null))
        assertEquals("PC · Offline", connectionText("PC", offline = true, pathLabel = "Tailscale"))
    }

    @Test fun searchStaysOpenWhileOpenedOrAQueryIsSet() {
        assertFalse(searchOpen(opened = false, query = ""))
        assertTrue(searchOpen(opened = true, query = ""))
        assertTrue(searchOpen(opened = false, query = "cl:"))
        assertTrue(searchOpen(opened = true, query = "x"))
    }

    @Test fun settingsMachineLinesNameTheStateAndTheEngineInUse() {
        assertEquals("debian: Online · In use", engineLine("debian", true, true))
        assertEquals("homeLP: Offline", engineLine("homeLP", false, false))
        assertEquals("workLP: Checking…", engineLine("workLP", null, false))
        assertEquals("workLP: Checking… · In use", engineLine("workLP", null, true))
    }

    // Messages and Usage formats (activity contract 5), in UTC and with a non-English default locale.
    private fun <T> utc(block: () -> T): T {
        val zone = TimeZone.getDefault()
        val locale = Locale.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
        Locale.setDefault(Locale.GERMANY)
        try { return block() } finally {
            TimeZone.setDefault(zone)
            Locale.setDefault(locale)
        }
    }

    private fun at(text: String) = Instant.parse(text).toEpochMilli()

    @Test fun activityNumbersUseUsGroupingAndDecimals() = utc {
        assertEquals("0", formatCount(0))
        assertEquals("1,234", formatCount(1234))
        assertEquals("1,234,567", formatCount(1_234_567))
        assertEquals("$2,148.62", formatCost(2148.62))
        assertEquals("$0.00", formatCost(0.0))
        assertEquals("$1,000,000.00", formatCost(1_000_000.0))
        assertEquals("Unpriced", formatCost(null))
        val tokens = listOf(0L to "0", 999L to "999", 1000L to "1.0K", 412_300L to "412.3K", 999_949L to "999.9K",
            999_950L to "1.0M", 845_200_000L to "845.2M", 999_950_000L to "1.00B", 1_940_000_000L to "1.94B")
        for ((value, text) in tokens) assertEquals("Tokens $value", text, formatTokens(value))
        assertEquals("38.4%", formatShare(.384))
        assertEquals("0.0%", formatShare(0.0))
        assertEquals("100.0%", formatShare(1.0))
    }

    @Test fun activityTimesAreLocal24HourWithEnglishMonths() = utc {
        val time = at("2026-10-24T16:38:00Z")
        assertEquals("16:38", formatTime(time))
        assertEquals("09:05", formatTime(at("2026-10-24T09:05:59Z")))
        assertEquals("Oct 24", formatDate(time))
        assertEquals("Today", dayText(time, at("2026-10-24T23:59:00Z")))
        assertEquals("Yesterday", dayText(time, at("2026-10-25T00:01:00Z")))
        assertEquals("Oct 24", dayText(time, at("2026-10-26T12:00:00Z")))
        assertEquals("09:00", bucketLabel(at("2026-10-24T09:00:00Z"), unit = "hour", last = false, short = true))
        assertEquals("Now", bucketLabel(at("2026-10-24T09:00:00Z"), unit = "hour", last = true, short = true))
        assertEquals("09:00", bucketLabel(at("2026-10-24T09:00:00Z"), unit = "hour", last = true, short = false))
        assertEquals("Oct 24", bucketLabel(at("2026-10-24T00:00:00Z"), unit = "day", last = false, short = true))
        assertEquals("Today", bucketLabel(at("2026-10-24T00:00:00Z"), unit = "day", last = true, short = true))
        assertEquals("Oct 24", bucketLabel(at("2026-10-24T00:00:00Z"), unit = "day", last = true, short = false))
    }

    @Test fun monthBucketLabelsUseEnglishAndShowYearBoundaries() = utc {
        val july = at("2026-07-01T00:00:00Z")
        val october = at("2026-10-01T00:00:00Z")
        val january = at("2027-01-01T00:00:00Z")
        assertEquals("Jul 2026", bucketLabel(july, "month", last = false, short = true, first = true))
        assertEquals("Jul", bucketLabel(july, "month", last = false, short = true))
        assertEquals("Jan 2027", bucketLabel(january, "month", last = false, short = true))
        assertEquals("This month", bucketLabel(january, "month", last = true, short = true, first = true))
        assertEquals("This month", bucketLabel(october, "month", last = true, short = true))
        assertEquals("October 2026", bucketLabel(october, "month", last = true, short = false))
        assertEquals("July 2026", bucketLabel(july, "month", last = false, short = false))
        assertEquals("January 2027", bucketLabel(january, "month", last = true, short = false))
    }

    @Test fun machineStatesAndLastReport() = utc {
        val report = at("2026-10-25T14:30:00Z")
        assertEquals("Local", machineStateText(ActivityMachine(state = "local")))
        assertEquals("Connected", machineStateText(ActivityMachine(state = "online", lastReportAtMs = report)))
        assertEquals("Offline", machineStateText(ActivityMachine(state = "offline")))
        assertEquals("", lastReportText(ActivityMachine(state = "offline")))
        assertEquals("", lastReportText(ActivityMachine(state = "online", lastReportAtMs = report)))
        assertEquals("Last report Oct 25, 14:30", lastReportText(ActivityMachine(state = "offline", lastReportAtMs = report)))
        assertEquals("Offline · last report Oct 25, 14:30", machineStateLine(ActivityMachine(state = "offline", lastReportAtMs = report)))
        assertEquals("Offline", machineStateLine(ActivityMachine(state = "offline")))
        assertEquals("Connected", machineStateLine(ActivityMachine(state = "online")))
    }

    @Test fun scanLineHasNoNumbersBeforeTheFilesAreListed() {
        assertEquals("", scanText(UsageScan(complete = true, files = 2707, scannedFiles = 2707)))
        assertEquals("Reading usage", scanText(UsageScan(complete = false, files = 0, scannedFiles = 0)))
        assertEquals("Reading usage: 120 of 2,707 files", scanText(UsageScan(complete = false, files = 2707, scannedFiles = 120)))
    }

    @Test fun pricesLineFollowsThePriceStatus() = utc {
        val fetched = at("2026-10-26T08:00:00Z")
        assertEquals("Prices: LiteLLM, Oct 26", pricesText(UsagePrices("LiteLLM", "fresh", fetched, 2131)))
        assertEquals("Prices: LiteLLM, Oct 26", pricesText(UsagePrices("LiteLLM", "cached", fetched, 2131)))
        assertEquals("Prices: loading", pricesText(UsagePrices("LiteLLM", "loading", null, 0)))
        assertEquals("Prices: not available", pricesText(UsagePrices("LiteLLM", "unavailable", null, 0)))
        assertEquals("", pricesText(UsagePrices()))
    }
}
