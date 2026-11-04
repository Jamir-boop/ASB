package local.asb.companion

import local.asb.companion.data.AsbJson
import local.asb.companion.data.Dashboard
import local.asb.companion.data.Thread
import local.asb.companion.notify.BIT_DONE
import local.asb.companion.notify.BIT_FAILED
import local.asb.companion.notify.notificationTitle
import local.asb.companion.ui.attentionIndicator
import local.asb.companion.ui.indicatorMeaning
import local.asb.companion.ui.rowPanelNote
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A Claude Code process that ended during a task: an Unknown row with the attention of a failed Idle row. */
class ProcessEndedTest {
    private val ended = Thread(id = "ended", state = "unknown", reason = "The Claude Code process ended during a task.",
        processEnded = true, unread = true, pending = true, alert = true, failedAttention = true, pendingSource = "observed-failure")

    @Test fun modelsReadProcessEndedWithFalseAsTheDefault() {
        val board = AsbJson.decodeFromString<Dashboard>("""{"threads":[{"id":"new","processEnded":true},{"id":"old"}]}""")
        assertTrue(board.threads[0].processEnded)
        assertFalse(board.threads[1].processEnded)
    }

    @Test fun anUnreadProcessEndHasItsOwnWords() {
        assertEquals("alert", attentionIndicator(ended))
        assertEquals("The Claude Code process ended during a task. Not read yet.", rowPanelNote(ended))
        assertEquals("Process ended during a task, unread", indicatorMeaning(ended, "alert"))
        assertEquals("Process ended", notificationTitle(ended, BIT_FAILED))
        // In the drawer the stored mark is a dot with the same words.
        val drawer = ended.copy(unread = false, alert = false, drawer = true)
        assertEquals("dot", attentionIndicator(drawer, drawer = true))
        assertEquals("Process ended during a task, unread", indicatorMeaning(drawer, "dot"))
        assertEquals("Failed task, unread", indicatorMeaning(drawer.copy(processEnded = false), "dot"))
        // A failed task and a usage limit keep their words.
        val failed = ended.copy(processEnded = false, state = "idle", lastOutcome = "failed")
        assertEquals("Failed. Not read yet.", rowPanelNote(failed))
        assertEquals("Failed task, unread", indicatorMeaning(failed, "alert"))
        assertEquals("Failed", notificationTitle(failed, BIT_FAILED))
        val limit = failed.copy(lastOutcome = "limit")
        assertEquals("Usage limit stopped the task. Not read yet.", rowPanelNote(limit))
        assertEquals("Usage limit", notificationTitle(limit, BIT_FAILED))
        assertEquals("Done", notificationTitle(ended, BIT_DONE))
    }

    @Test fun aReadProcessEndIsAQuietUnknownRow() {
        val read = ended.copy(unread = false, pending = false, alert = false, failedAttention = false, pendingSource = "")
        assertEquals("", attentionIndicator(read))
        assertEquals("", rowPanelNote(read))
    }
}
