package local.asb.companion

import local.asb.companion.data.Thread
import local.asb.companion.ui.COMFORTABLE_TITLE_LINES
import local.asb.companion.ui.COMFORTABLE_TITLE_MIN_LINES
import local.asb.companion.ui.CORNER_TARGET
import local.asb.companion.ui.WORKING_PULSE_MS
import local.asb.companion.ui.alertIsLimit
import local.asb.companion.ui.cardTitle
import local.asb.companion.ui.comfortableCardHeight
import local.asb.companion.ui.cornerControls
import local.asb.companion.ui.cornerDescription
import local.asb.companion.ui.cornerReserve
import local.asb.companion.ui.cornerSlots
import local.asb.companion.ui.openLabel
import local.asb.companion.ui.openReason
import local.asb.companion.ui.panelReason
import local.asb.companion.ui.rowPanelControls
import local.asb.companion.ui.workingSignAlpha
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Android council round 1, card and inspector issues 4, 5, 6, and 10 (made-up rows). */
class AndroidCouncilRoundOneCardsTest {
    private val now = 1_800_000_000_000L
    private val idle = Thread(id = "a", title = "fix flaky upload test", state = "idle", updatedAtMs = now)

    @Test fun theComfortableTitleTakesOneOrTwoLinesAndTheCardKeepsItsMinimum() {
        assertEquals(1, COMFORTABLE_TITLE_MIN_LINES)
        assertEquals(2, COMFORTABLE_TITLE_LINES)
        // The minimum height still has room for two title lines, so a one-line title only moves the state line up.
        assertEquals(68f, comfortableCardHeight(1f), .001f)
    }

    @Test fun aRowWithNoTitleIsAnUntitledSession() {
        assertEquals("Untitled session", cardTitle(idle.copy(title = "")))
        assertEquals("Untitled session", cardTitle(idle.copy(title = " \n\t　")))
        assertEquals("two words", cardTitle(idle.copy(title = "  two \n words ")))
    }

    @Test fun eachPendingCornerSaysItsMeaningNotItsGlyph() {
        fun words(row: Thread) = cornerControls(row, false, false, now).map { cornerDescription(row, it) }
        assertEquals(listOf("Needs your answer. Mark read in ASB: fix flaky upload test"),
            words(idle.copy(state = "waiting", questionAttention = true)))
        assertEquals(listOf("Waiting for approval. A user action is required in the original app. Mark read in ASB: fix flaky upload test"),
            words(idle.copy(state = "waiting", actionRequired = true)))
        assertEquals(listOf("Waiting for approval. A user action is required in the original app: fix flaky upload test"),
            words(idle.copy(state = "waiting", actionRequired = true, actionAttention = false)))
        val failed = idle.copy(unread = true, alert = true, lastOutcome = "failed")
        assertEquals(listOf("Failed. Mark read in ASB: fix flaky upload test"), words(failed))
        assertFalse(alertIsLimit(failed))
        val limit = failed.copy(lastOutcome = "limit")
        assertEquals(listOf("Usage limit. Mark read in ASB: fix flaky upload test"), words(limit))
        assertTrue(alertIsLimit(limit))
        assertEquals(listOf("Done, unread. Mark read in ASB: Untitled session"),
            words(idle.copy(title = "", unread = true, completionAttention = true)))
        // A control that is not a Pending mark keeps its action words.
        assertEquals(listOf("Unpin in ASB: fix flaky upload test"), words(idle.copy(pinned = true)))
    }

    @Test fun cornerSlotsKeepTheirPlacesAndReserveTheirWidth() {
        fun slots(row: Thread) = cornerSlots(cornerControls(row, false, false, now)).map { it?.kind }
        assertEquals(emptyList<String?>(), slots(idle))
        assertEquals(listOf("pin"), slots(idle.copy(pinned = true)))
        // The read mark keeps its slot left of the pin slot, also with no pin.
        assertEquals(listOf("dot", null), slots(idle.copy(unread = true)))
        assertEquals(listOf("dot", "pin"), slots(idle.copy(unread = true, pinned = true)))
        assertEquals(listOf("drawer", null, "pin"), slots(idle.copy(drawer = true, pinned = true)))
        assertEquals(48, CORNER_TARGET)
        assertEquals(0, cornerReserve(emptyList()))
        assertEquals(3 * 48, cornerReserve(cornerSlots(cornerControls(idle.copy(drawer = true), false, false, now))))
    }

    @Test fun theOpenButtonNamesTheMachineAndADimmedControlSaysWhy() {
        val local = idle.copy(canOpen = true, providerLabel = "Claude Desktop Code")
        assertEquals("Open on studio-pc", openLabel(local, "studio-pc"))
        assertEquals("Open on travel-laptop", openLabel(local.copy(machineName = "travel-laptop"), "studio-pc"))
        assertEquals("Open on the PC", openLabel(local, ""))
        assertEquals("", openReason(local))
        assertEquals("Open it on travel-laptop.", openReason(idle.copy(remote = true, machineName = "travel-laptop")))
        assertEquals("ASB does not open CLI sessions.", openReason(idle.copy(surface = "cli")))
        assertEquals("This session has no direct link.", openReason(idle))
        val working = idle.copy(state = "working", pinned = true, workingSinceMs = now)
        assertEquals("A Working session cannot go in the drawer.", panelReason(working, "drawer", rowPanelControls(working)))
        assertEquals("Only an unread or waiting session can go in the drawer.", panelReason(idle, "drawer", rowPanelControls(idle)))
        val unread = idle.copy(unread = true)
        assertEquals("", panelReason(unread, "drawer", rowPanelControls(unread)))
        assertEquals("", panelReason(idle, "pinned", rowPanelControls(idle)))
    }

    @Test fun theWorkingSignPulsesAndIsStillWithAnimationsOff() {
        assertEquals(1600, WORKING_PULSE_MS)
        assertEquals(1f, workingSignAlpha(false, 0), .001f)
        assertEquals(.4f, workingSignAlpha(false, 4), .001f)
        assertEquals(1f, workingSignAlpha(false, 8), .001f)
        for (step in 0..9) {
            assertEquals(1f, workingSignAlpha(true, step), .001f)
            assertTrue(workingSignAlpha(false, step) in .4f - .001f..1f + .001f)
        }
    }
}
