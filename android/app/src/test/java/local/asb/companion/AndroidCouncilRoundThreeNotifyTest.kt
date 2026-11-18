package local.asb.companion

import android.app.Notification
import local.asb.companion.data.Thread
import local.asb.companion.notify.ActiveChild
import local.asb.companion.notify.BIT_DONE
import local.asb.companion.notify.BIT_FAILED
import local.asb.companion.notify.BIT_INPUT
import local.asb.companion.notify.Repost
import local.asb.companion.notify.childSpec
import local.asb.companion.notify.liveLines
import local.asb.companion.notify.notificationId
import local.asb.companion.notify.notificationTag
import local.asb.companion.notify.summaryText
import local.asb.companion.notify.textOffReposts
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Android council round 3, brief W11: question text leaves posted children, Live lines, and the summary words. */
class AndroidCouncilRoundThreeNotifyTest {
    private val question = "Should the retry button keep the old order ID?"
    private val asking = Thread(id = "cl-1016", title = "checkout-flow: wire the retry button", projectName = "checkout-flow",
        machineName = "studio-pc", sourceLabel = "Claude", canOpen = true, unread = true, questionAttention = true,
        questionText = question)
    private val off = asking.copy(questionText = "")
    private val tag = notificationTag(asking.key, BIT_INPUT)
    private fun child(bigText: Boolean = true) = ActiveChild(tag, notificationId(asking.key, BIT_INPUT), bigText, 1_700_000_000_000)

    @Test fun aBlankQuestionWithABigTextChildIsPostedAgain() {
        assertEquals(listOf(Repost(child(), off)), textOffReposts(listOf(child()), listOf(off), ""))
    }

    @Test fun nothingChangesWithoutABigTextOrWithAQuestion() {
        assertEquals(emptyList<Repost>(), textOffReposts(listOf(child(bigText = false)), listOf(off), ""))
        assertEquals(emptyList<Repost>(), textOffReposts(listOf(child()), listOf(asking), ""))
    }

    @Test fun aGoneRowOrARowThatNoLongerNeedsInputIsNotPostedAgain() {
        assertEquals(emptyList<Repost>(), textOffReposts(listOf(child()), emptyList(), ""))
        assertEquals(emptyList<Repost>(), textOffReposts(listOf(child()), listOf(off.copy(questionAttention = false)), ""))
        // The remote rows of another engine prove nothing, as in cleared().
        assertEquals(emptyList<Repost>(), textOffReposts(listOf(child()), listOf(off.copy(remote = true)), "m-2"))
        // A Done child of the same row is not a Needs input child.
        val done = ActiveChild(notificationTag(asking.key, BIT_DONE), notificationId(asking.key, BIT_DONE), true, 1)
        assertEquals(emptyList<Repost>(), textOffReposts(listOf(done), listOf(off), ""))
    }

    @Test fun theRepostIsANormalPostWithNoQuestionAndTheOldTime() {
        val (old, row) = textOffReposts(listOf(child()), listOf(off), "").single()
        val normal = childSpec(off, BIT_INPUT, "studio-pc")
        val repost = childSpec(row, BIT_INPUT, "studio-pc").copy(whenMs = old.whenMs, onlyAlertOnce = true)
        assertNull(repost.words.bigText)
        assertEquals(normal.copy(whenMs = 1_700_000_000_000, onlyAlertOnce = true), repost)
        // The lock-screen version keeps the old time too (round 4, F11).
        assertEquals(old.whenMs, repost.publicWhenMs)
        assertEquals("asb_input", repost.channel)
        assertEquals("asb", repost.group)
        assertEquals(Notification.CATEGORY_REMINDER, repost.category)
        assertEquals(listOf("Open on PC" to "open", "Mark read" to "mark-read"), repost.actions)
        // The question post differs only in its expanded text.
        val withQuestion = childSpec(asking, BIT_INPUT, "studio-pc")
        assertEquals(question, withQuestion.words.bigText)
        assertEquals(normal, withQuestion.copy(words = withQuestion.words.copy(bigText = null)))
    }

    @Test fun anUntitledRowIsAnUntitledSessionInLive() {
        val untitled = Thread(id = "u1", state = "working", title = "", projectName = "scratch")
        assertEquals(listOf("Working: Untitled session"), liveLines(listOf(untitled)))
    }

    @Test fun theSummaryCountsAlertsThenKinds() {
        assertEquals("2 alerts: 1 needs input · 1 done",
            summaryText(listOf(notificationTag("a", BIT_INPUT), notificationTag("b", BIT_DONE))))
        assertEquals("3 alerts: 1 needs input · 2 failed",
            summaryText(listOf(notificationTag("a", BIT_INPUT), notificationTag("b", BIT_FAILED), notificationTag("c", BIT_FAILED))))
    }
}
