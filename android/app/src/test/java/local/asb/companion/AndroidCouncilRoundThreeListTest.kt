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
import local.asb.companion.ui.muteChoiceRows
import local.asb.companion.ui.pillDescription
import local.asb.companion.ui.pillLabel
import local.asb.companion.ui.showMoreCount
import local.asb.companion.ui.titleLines
import org.junit.Assert.assertEquals
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

    @Test fun theLegendHasThePcWordsAndTheCardWordsStay() {
        // As the PC legend (DESIGN.md): one row for the filled question mark, one for the passive mark, and one dot row.
        assertEquals(listOf("Needs your answer or approval", "Waiting for approval, read", "Failed", "Usage limit", "Unread",
            "Mark read when done", "Pinned", "In the drawer", "Muted"), CARD_MARKS.map { it.words })
        // The card TalkBack words do not change.
        assertEquals("Needs your answer", cornerMeaning(Thread(), CARD_MARKS[0].control!!))
        assertEquals("Waiting for approval", cornerMeaning(Thread(), CARD_MARKS[1].control!!))
        assertEquals("Failed", cornerMeaning(Thread(lastOutcome = "failed"), CARD_MARKS[2].control!!))
        assertEquals("Usage limit", cornerMeaning(Thread(lastOutcome = "limit"), CARD_MARKS[3].control!!))
        assertEquals("Done, unread", cornerMeaning(Thread(completionAttention = true), CornerControl("dot", "mark-read", "")))
        assertEquals("Unread", cornerMeaning(Thread(), CARD_MARKS[4].control!!))
        // The glyph follows the mark: the clock only for the usage limit, and the bell has no corner control.
        assertEquals(listOf(false, false, false, true, false), CARD_MARKS.take(5).map { it.limit })
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
