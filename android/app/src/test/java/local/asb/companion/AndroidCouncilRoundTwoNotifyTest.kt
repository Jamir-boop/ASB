package local.asb.companion

import local.asb.companion.data.Thread
import local.asb.companion.notify.ABOUT_DONE
import local.asb.companion.notify.ABOUT_FAILED
import local.asb.companion.notify.ABOUT_INPUT
import local.asb.companion.notify.BIT_DONE
import local.asb.companion.notify.BIT_FAILED
import local.asb.companion.notify.BIT_INPUT
import local.asb.companion.notify.NotificationWords
import local.asb.companion.notify.liveLines
import local.asb.companion.notify.publicWords
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** Android council round 2, brief W4: public words per kind, pending titles in Live, and the switch captions. */
class AndroidCouncilRoundTwoNotifyTest {
    private val question = "Should the retry button keep the old order ID?"
    private val row = Thread(id = "cl-1", title = "checkout-flow: wire the retry button", projectName = "checkout-flow",
        machineName = "studio-pc", sourceLabel = "Claude", questionAttention = true, questionText = question)

    @Test fun publicWordsNameOnlyTheKind() {
        assertEquals(NotificationWords("ASB", "A session needs your answer"), publicWords(row, BIT_INPUT))
        assertEquals(NotificationWords("ASB", "A task failed"), publicWords(row.copy(lastOutcome = "failed"), BIT_FAILED))
        assertEquals(NotificationWords("ASB", "A task hit a usage limit"), publicWords(row.copy(lastOutcome = "limit"), BIT_FAILED))
        assertEquals(NotificationWords("ASB", "A task is done"), publicWords(row, BIT_DONE))
        for (kind in listOf(BIT_INPUT, BIT_FAILED, BIT_DONE)) for (outcome in listOf("", "limit")) {
            val words = publicWords(row.copy(lastOutcome = outcome), kind).toString()
            for (secret in listOf(question, row.title, "checkout-flow", "studio-pc", "Claude")) assertFalse(secret in words)
        }
    }

    @Test fun liveLinesListPendingTitlesFirstThenWorkingTitles() {
        fun r(id: String, state: String = "idle", pending: Boolean = false, at: Long = 0) =
            Thread(id = id, state = state, pending = pending, title = "Task $id", updatedAtMs = at)
        // The cards' order: the newest pending row first; at most 3 pending titles.
        val rows = listOf(r("w1", "working"), r("p1", pending = true, at = 100), r("p2", pending = true, at = 400),
            r("p3", pending = true, at = 300), r("p4", pending = true, at = 200), r("i1"))
        assertEquals(listOf("Task p2", "Task p3", "Task p4", "Task w1"), liveLines(rows))
        // A pending row that works is listed once, with the pending titles.
        assertEquals(listOf("Task a", "Task w1"), liveLines(listOf(r("w1", "working"), r("a", "working", pending = true))))
        assertEquals(listOf("No session is working."), liveLines(listOf(r("i1"), r("i2", "waiting"))))
        assertEquals(listOf("No session is working."), liveLines(emptyList()))
    }

    @Test fun captionsAreTheChannelDescriptions() {
        assertEquals("A session finished a task.", ABOUT_DONE)
        assertEquals("A task failed or hit a usage limit.", ABOUT_FAILED)
        assertEquals("A session waits for your answer or approval.", ABOUT_INPUT)
    }
}
