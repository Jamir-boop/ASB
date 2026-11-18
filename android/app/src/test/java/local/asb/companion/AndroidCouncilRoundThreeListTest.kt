package local.asb.companion

import local.asb.companion.data.Thread
import local.asb.companion.ui.CARD_MARKS
import local.asb.companion.ui.CornerControl
import local.asb.companion.ui.Filter
import local.asb.companion.ui.MUTE_CHOICES
import local.asb.companion.ui.PENDING_HEADER
import local.asb.companion.ui.ROW_PAGE
import local.asb.companion.ui.activeFilterChips
import local.asb.companion.ui.cornerMeaning
import local.asb.companion.ui.discRefreshLabel
import local.asb.companion.ui.joinSentences
import local.asb.companion.ui.liveOfferShows
import local.asb.companion.ui.muteChoiceRows
import local.asb.companion.ui.pillDescription
import local.asb.companion.ui.pillLabel
import local.asb.companion.ui.showMoreCount
import local.asb.companion.ui.titleLines
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidCouncilRoundThreeListTest {
    @Test fun aValueThatAPillSetsHasNoChipAndSheetFiltersKeepTheirs() {
        // Each pill on alone: no chip.
        assertEquals(emptyList<Pair<String, String>>(), activeFilterChips(Filter(pendingOnly = true)))
        assertEquals(emptyList<Pair<String, String>>(), activeFilterChips(Filter(drawerOnly = true)))
        assertEquals(emptyList<Pair<String, String>>(), activeFilterChips(Filter(states = setOf("working"))))
        // The sheet filters keep their chips beside a pill.
        assertEquals(
            listOf("state:waiting" to "Waiting", "state:idle" to "Idle", "app" to "Codex", "archive" to "Include archived"),
            activeFilterChips(Filter(pendingOnly = true, drawerOnly = true, states = setOf("waiting", "idle"), app = "codex",
                archived = true)),
        )
        assertEquals(listOf("app" to "OpenCode"), activeFilterChips(Filter(states = setOf("working"), app = "opencode")))
    }

    @Test fun thePendingHeaderHasNoNumber() {
        assertEquals("Pending", PENDING_HEADER)
    }

    @Test fun pillsSayZeroSessionsButShowNoZero() {
        for (label in listOf("Pending", "Working", "Drawer")) {
            assertEquals(label, pillLabel(label, 0))
            assertEquals("$label, 0 sessions", pillDescription(label, 0))
        }
        assertEquals("Drawer, 1 session", pillDescription("Drawer", 1))
    }

    @Test fun theLiveOfferShowsOnlyPairedWithLiveOffNotClosedAndRows() {
        assertTrue(liveOfferShows(paired = true, liveNotification = false, closed = false, listEmpty = false))
        assertFalse(liveOfferShows(paired = false, liveNotification = false, closed = false, listEmpty = false))
        assertFalse(liveOfferShows(paired = true, liveNotification = true, closed = false, listEmpty = false))
        assertFalse(liveOfferShows(paired = true, liveNotification = false, closed = true, listEmpty = false))
        assertFalse(liveOfferShows(paired = true, liveNotification = false, closed = false, listEmpty = true))
    }

    @Test fun theLegendWordsAreTheCornerMeanings() {
        val failed = Thread(lastOutcome = "failed")
        val limit = Thread(lastOutcome = "limit")
        val done = Thread(completionAttention = true)
        val read = CornerControl("question", "mark-read", "")
        assertEquals(
            listOf(
                cornerMeaning(Thread(), read),
                cornerMeaning(Thread(), CornerControl("question", null, "")),
                cornerMeaning(failed, CornerControl("alert", "mark-read", "")),
                cornerMeaning(limit, CornerControl("alert", "mark-read", "")),
                cornerMeaning(done, CornerControl("dot", "mark-read", "")),
                cornerMeaning(Thread(), CornerControl("dot", "mark-read", "")),
            ),
            CARD_MARKS.take(6).map { it.words },
        )
        assertEquals(listOf("Mark read when done", "Pinned", "In the drawer", "Muted"), CARD_MARKS.drop(6).map { it.words })
        // The glyph follows the mark: the clock only for the usage limit, and the bell has no corner control.
        assertEquals(listOf(false, false, false, true), CARD_MARKS.take(4).map { it.limit })
        assertEquals(null, CARD_MARKS.last().control)
    }

    @Test fun aReasonThatEndsWithAPeriodGetsNoSecondOne() {
        assertEquals("deploy. Unknown. homeLP is not reachable. 3m ago",
            joinSentences(listOf("deploy", "Unknown", "homeLP is not reachable.", "", "3m ago")))
    }

    @Test fun muteChipsAreThreeThenTwo() {
        assertEquals(listOf(3, 2), muteChoiceRows(MUTE_CHOICES).map { it.size })
        assertEquals(MUTE_CHOICES, muteChoiceRows(MUTE_CHOICES).flatten())
    }

    @Test fun titleLineTwoTakesTheRestForTheFullWidth() {
        // Line 1 ends at its word break; line 2 is the rest, drawn with the full text width.
        assertEquals("draft the onboarding email" to "copy", titleLines("draft the onboarding email copy", 27))
        assertEquals("rename the session" to "store keys", titleLines("rename the session store keys", 18))
        assertEquals("short" to "", titleLines("short", 5))
    }

    @Test fun showMoreNamesTheRowsThatTheTapAdds() {
        // 131 rows with one archived row: 130 rows, 100 shown, the tap adds 30.
        assertEquals(30, showMoreCount(130 - ROW_PAGE))
        assertEquals(ROW_PAGE, showMoreCount(250 - ROW_PAGE))
    }

    @Test fun theDiscMenuSaysRetryWhileOffline() {
        assertEquals("Retry", discRefreshLabel(true))
        assertEquals("Refresh", discRefreshLabel(false))
    }
}
