package local.asb.companion

import android.app.Notification
import kotlinx.serialization.encodeToString
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Dashboard
import local.asb.companion.data.Thread
import local.asb.companion.notify.BIT_DONE
import local.asb.companion.notify.BIT_FAILED
import local.asb.companion.notify.BIT_INPUT
import local.asb.companion.notify.NotificationWords
import local.asb.companion.notify.PUBLIC_WORDS
import local.asb.companion.notify.notificationCategory
import local.asb.companion.notify.notificationTag
import local.asb.companion.notify.notificationWords
import local.asb.companion.notify.summaryText
import local.asb.companion.notify.update
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** Android council round 1, brief C: the notification words match the card, with the question text in the private version. */
class AndroidCouncilRoundOneNotifyTest {
    private val question = "Should the retry button keep the old order ID?"
    private val row = Thread(id = "cl-1", title = "checkout-flow:  wire the retry button", sourceLabel = "Claude",
        questionAttention = true, questionText = question)

    @Test fun titlesAndTextsMatchTheCard() {
        assertEquals(NotificationWords("Needs your answer · studio-pc", "checkout-flow: wire the retry button", "Claude", question),
            notificationWords(row, BIT_INPUT, "studio-pc"))
        assertEquals("Waiting for approval · studio-pc",
            notificationWords(row.copy(actionRequired = true), BIT_INPUT, "studio-pc").title)
        assertEquals("Failed · studio-pc", notificationWords(row.copy(lastOutcome = "failed"), BIT_FAILED, "studio-pc").title)
        assertEquals("Usage limit · studio-pc", notificationWords(row.copy(lastOutcome = "limit"), BIT_FAILED, "studio-pc").title)
        assertEquals("Done · studio-pc", notificationWords(row, BIT_DONE, "studio-pc").title)
        // A row of another machine of the group names that machine.
        assertEquals("Done · travel-laptop",
            notificationWords(row.copy(remote = true, machineName = "travel-laptop"), BIT_DONE, "studio-pc").title)
        assertEquals("Untitled session", notificationWords(row.copy(title = " "), BIT_DONE, "studio-pc").text)
    }

    @Test fun theQuestionIsOnlyInThePrivateNeedsInputVersion() {
        assertEquals(question, notificationWords(row, BIT_INPUT, "studio-pc").bigText)
        assertNull(notificationWords(row, BIT_DONE, "studio-pc").bigText)
        assertNull(notificationWords(row, BIT_FAILED, "studio-pc").bigText)
        assertNull(notificationWords(row.copy(questionText = ""), BIT_INPUT, "studio-pc").bigText)
        assertEquals(NotificationWords("ASB", "A session needs attention"), PUBLIC_WORDS)
        assertFalse(PUBLIC_WORDS.toString().contains(question))
    }

    @Test fun categoriesPerKind() {
        assertEquals(Notification.CATEGORY_REMINDER, notificationCategory(BIT_INPUT))
        assertEquals(Notification.CATEGORY_ERROR, notificationCategory(BIT_FAILED))
        assertEquals(Notification.CATEGORY_STATUS, notificationCategory(BIT_DONE))
    }

    @Test fun summaryCountsByKind() {
        val tags = listOf(notificationTag("a:b", BIT_INPUT), notificationTag("c", BIT_FAILED), notificationTag("d", BIT_DONE))
        assertEquals("1 needs input · 1 failed · 1 done", summaryText(tags))
        assertEquals("2 done", summaryText(listOf(notificationTag("d", BIT_DONE), notificationTag("e", BIT_DONE))))
        // The Connection notification of a removed phone has no kind.
        assertEquals("1 failed", summaryText(listOf("asb-status", notificationTag("c", BIT_FAILED))))
    }

    @Test fun theSavedBaselineHasNoQuestionText() {
        val board = AsbJson.decodeFromString<Dashboard>(
            """{"threads":[{"id":"cl-1","questionAttention":true,"questionText":"$question"}]}""")
        assertEquals(question, board.threads[0].questionText)
        val saved = AsbJson.encodeToString(update(null, board.threads, 1000))
        assertFalse(saved.contains(question))
        assertFalse(saved.contains("questionText"))
    }
}
