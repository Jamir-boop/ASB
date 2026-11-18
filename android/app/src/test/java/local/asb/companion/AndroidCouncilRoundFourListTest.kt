package local.asb.companion

import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import java.time.Instant
import java.time.ZoneOffset
import local.asb.companion.data.Palette
import local.asb.companion.data.Thread
import local.asb.companion.ui.COPIED_MS
import local.asb.companion.ui.Filter
import local.asb.companion.ui.MUTE_CHOICES
import local.asb.companion.ui.OFFLINE_COUNT_ALPHA
import local.asb.companion.ui.activeFilterChips
import local.asb.companion.ui.cardTones
import local.asb.companion.ui.compactMarkCell
import local.asb.companion.ui.filtersDescription
import local.asb.companion.ui.inspectorPlace
import local.asb.companion.ui.muteChoiceDescription
import local.asb.companion.ui.muteChoiceLines
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Android council round 4, list and inspector fixes (made-up rows). */
class AndroidCouncilRoundFourListTest {
    // Wednesday 2026-11-18 08:31 UTC.
    private val now = Instant.parse("2026-11-18T08:31:00Z").toEpochMilli()
    private val utc = ZoneOffset.UTC

    @Test fun copiedShowsForOnePointSixSeconds() = assertEquals(1_600L, COPIED_MS)

    @Test fun muteChipsAreTheTimeOverTheEnd() {
        assertEquals(listOf("30 min" to "until 09:01", "1 hour" to "until 09:31", "8 hours" to "until 16:31",
            "1 day" to "until Thu", "Always" to ""), MUTE_CHOICES.map { (words, ms) -> muteChoiceLines(words, ms, now, utc) })
        // A time under 24 hours keeps its clock time past midnight; only 1 day shows the weekday.
        val late = Instant.parse("2026-11-18T20:00:00Z").toEpochMilli()
        assertEquals("8 hours" to "until 04:00", muteChoiceLines("8 hours", 28_800_000L, late, utc))
        val nearMidnight = Instant.parse("2026-11-18T23:45:00Z").toEpochMilli()
        assertEquals("30 min" to "until 00:15", muteChoiceLines("30 min", 1_800_000L, nearMidnight, utc))
        assertEquals(listOf("30 min, until 09:01", "1 hour, until 09:31", "8 hours, until 16:31", "1 day, until Thursday 08:31",
            "Always, mute until you unmute"), MUTE_CHOICES.map { (words, ms) -> muteChoiceDescription(words, ms, now, utc) })
    }

    @Test fun theFiltersButtonSaysHowManyAreOn() {
        assertEquals("Filters", filtersDescription(Filter()))
        // A pill value is not a sheet filter.
        assertEquals("Filters", filtersDescription(Filter(pendingOnly = true, drawerOnly = true)))
        assertEquals("Filters", filtersDescription(Filter(states = setOf("working"))))
        // The Working pill alone does not draw the Filters button selected.
        assertTrue(activeFilterChips(Filter(states = setOf("working"))).isEmpty())
        assertEquals("Filters, 1 on", filtersDescription(Filter(archived = true)))
        assertEquals("Filters, 3 on", filtersDescription(Filter(states = setOf("waiting", "idle"), archived = true)))
    }

    @Test fun anOfflineWorkingWordHasTheCaptionTone() {
        val palette = Palette()
        val working = Thread(state = "working")
        assertEquals(palette.success, cardTones(palette, working, true, false, false, now).state)
        val offline = cardTones(palette, working, true, false, false, now, offline = true)
        assertEquals(offline.caption, offline.state)
        // Other states keep their tone.
        val idle = Thread(state = "idle")
        assertEquals(cardTones(palette, idle, true, false, false, now), cardTones(palette, idle, true, false, false, now, true))
        assertEquals(.55f, OFFLINE_COUNT_ALPHA)
    }

    @Test fun aPinnedCompactRowShowsThePinOnlyWithNoIndicator() {
        assertEquals("pin", compactMarkCell("", pinned = true))
        assertEquals("question", compactMarkCell("question", pinned = true))
        assertEquals("", compactMarkCell("", pinned = false))
    }

    @Test fun theInspectorKeepsItsTopEdgeAfterASizeChange() {
        val safe = IntRect(0, 0, 1000, 2000)
        val point = IntOffset(500, 400)
        val first = inspectorPlace(point, IntSize(900, 1500), safe, null)
        assertEquals(IntOffset(50, 400), first)
        // Shorter: the same top edge.
        assertEquals(first, inspectorPlace(point, IntSize(900, 1300), safe, first))
        // Taller at the same anchor: the top stays while the bottom fits, then moves up only as far as it must.
        assertEquals(first, inspectorPlace(point, IntSize(900, 1600), safe, first))
        assertEquals(IntOffset(50, 200), inspectorPlace(point, IntSize(900, 1800), safe, first))
        // A panel pushed up at the window end keeps that top when it shrinks (r4 e57 to e58), and does not drop to the point.
        val low = inspectorPlace(IntOffset(500, 900), IntSize(900, 1500), safe, null)
        assertEquals(IntOffset(50, 500), low)
        assertEquals(low, inspectorPlace(IntOffset(500, 900), IntSize(900, 1300), safe, low))
    }
}
