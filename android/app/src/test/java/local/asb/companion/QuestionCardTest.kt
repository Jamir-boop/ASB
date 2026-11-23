package local.asb.companion

import kotlinx.serialization.encodeToString
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Dashboard
import local.asb.companion.data.PhoneAnswer
import local.asb.companion.data.PhoneQuestion
import local.asb.companion.data.QuestionItem
import local.asb.companion.data.QuestionOption
import local.asb.companion.data.Store
import local.asb.companion.data.Thread
import local.asb.companion.net.AnswerReply
import local.asb.companion.notify.BIT_INPUT
import local.asb.companion.notify.notificationTag
import local.asb.companion.notify.update
import local.asb.companion.ui.CardStatus
import local.asb.companion.ui.QUESTION_CLOSED
import local.asb.companion.ui.SEND_CLOSED
import local.asb.companion.ui.keptQuestion
import local.asb.companion.ui.OTHER_LIMIT
import local.asb.companion.ui.QuestionCard
import local.asb.companion.ui.cleanOther
import local.asb.companion.ui.questionRowToOpen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class QuestionCardTest {
    private val id = "0123456789abcdef0123456789abcdef"
    private val single = QuestionItem("Which order?", "Retry", listOf(QuestionOption(" Oldest ", "First in, first out"), QuestionOption("newest")))
    private val multi = QuestionItem("Which checks?", options = listOf(QuestionOption("Tests"), QuestionOption("Docs"), QuestionOption("Lint")),
        multiSelect = true)
    private val question = PhoneQuestion(id, listOf(single, multi))

    private fun row(json: String): Thread = AsbJson.decodeFromString<Dashboard>("""{"threads":[$json]}""").threads.single()

    private val validJson = """{"requestId":"$id","questions":[{"question":"Which order?","header":"Retry","options":""" +
        """[{"label":" Oldest ","description":"First in, first out"},{"label":"newest"}]},""" +
        """{"question":"Which checks?","options":[{"label":"Tests"},{"label":"Docs"},{"label":"Lint"}],"multiSelect":true}]}"""

    @Test fun aValidQuestionDecodesWithItsLabelsAsSent() {
        assertEquals(question, row("""{"id":"one","questionText":"Which order?","question":$validJson}""").question)
        assertNull(row("""{"id":"one"}""").question)
    }

    @Test fun aMalformedQuestionIsNullAndTheRowStays() {
        val option = """{"label":"Yes"}"""
        fun item(options: String = "[$option]", extra: String = "") = """{"question":"Ask?","options":$options$extra}"""
        val cases = listOf(
            "null", "\"text\"", "[]",
            """{"requestId":"${"A".repeat(32)}","questions":[${item()}]}""",
            """{"requestId":"abc","questions":[${item()}]}""",
            """{"requestId":"$id","questions":[]}""",
            """{"requestId":"$id","questions":[${List(5) { item() }.joinToString(",")}]}""",
            """{"requestId":"$id","questions":[${item("[]")}]}""",
            """{"requestId":"$id","questions":[${item("[${List(9) { """{"label":"L$it"}""" }.joinToString(",")}]")}]}""",
            """{"requestId":"$id","questions":[${item("[$option,$option]")}]}""",
            """{"requestId":"$id","questions":[${item("""[{"label":""}]""")}]}""",
            """{"requestId":"$id","questions":[{"question":"","options":[$option]}]}""",
            """{"requestId":"$id","questions":[{"question":5,"options":[$option]}]}""",
            """{"requestId":"$id","questions":[${item(extra = ""","multiSelect":"true"""")}]}""",
            """{"requestId":"$id","questions":[${item(extra = ""","header":7""")}]}""",
            """{"requestId":"$id","questions":[${item("""[{"label":"Yes","description":false}]""")}]}""",
        )
        for (case in cases) {
            val row = row("""{"id":"one","title":"Kept","question":$case,"questionAttention":true}""")
            assertNull(case, row.question)
            assertEquals("Kept", row.title)
            assertTrue(row.questionAttention)
        }
        // Four questions of eight options is the limit.
        val eight = "[${List(8) { """{"label":"L$it"}""" }.joinToString(",")}]"
        assertEquals(4, row("""{"id":"one","question":{"requestId":"$id","questions":[${List(4) { item(eight) }.joinToString(",")}]}}""")
            .question?.questions?.size)
    }

    @Test fun theSavedBaselineHasNoQuestion() {
        val saved = AsbJson.encodeToString(update(null, listOf(row("""{"id":"one","questionAttention":true,"question":$validJson}""")), 1000))
        assertFalse(saved.contains("Which order"))
        assertFalse(saved.contains("Oldest"))
        val preferences = MemoryPreferences(mutableMapOf("token" to "paired"))
        val store = Store(preferences)
        val kept = keptQuestion(question, null)
        val choices = QuestionCard(kept.question!!).type(question, 0, "Private Other answer")
        store.saveBaselineIfPaired("paired", saved, "")
        assertEquals(saved, Store(preferences).baseline)
        assertSame(question, kept.question)
        assertEquals("Private Other answer", choices.other[0])
        val atRest = preferences.values.toString()
        for (text in listOf("Which order", "Which checks", "Oldest", "First in, first out", "Private Other answer", id)) {
            assertFalse(text, atRest.contains(text))
        }
    }

    @Test fun aQuestionThatLeavesTheRowStaysClosedInPlace() {
        val live = keptQuestion(null, question)
        assertSame(question, live.question)
        assertFalse(live.closed)
        val kept = keptQuestion(live.question, null)
        assertSame(question, kept.question)
        assertTrue(kept.closed)
        assertEquals(kept, keptQuestion(kept.question, null))
    }

    @Test fun theSameRequestBackMakesTheKeptChoicesLiveAgain() {
        val choices = QuestionCard(question).choose(question, 0, "newest").type(question, 1, "More checks")
        val kept = keptQuestion(question, null)
        val back = keptQuestion(kept.question, question.copy())
        assertFalse(back.closed)
        assertEquals(choices.requestId, back.question!!.requestId)
        assertEquals(listOf("newest"), choices.selected[0])
        assertEquals("More checks", choices.other[1])
        assertTrue(choices.canSend(back.question, offline = false, closed = back.closed))
    }

    @Test fun aNewRequestReplacesTheKeptQuestionAndStartsWithNewChoices() {
        val choices = QuestionCard(question).choose(question, 0, "newest").type(question, 1, "More checks")
        val next = question.copy(requestId = "f".repeat(32))
        val replaced = keptQuestion(question, next)
        assertSame(next, replaced.question)
        assertFalse(replaced.closed)
        assertFalse(choices.requestId == replaced.question!!.requestId)
        val fresh = QuestionCard(replaced.question)
        assertEquals(listOf(emptyList<String>(), emptyList<String>()), fresh.selected)
        assertEquals(listOf("", ""), fresh.other)
        assertNull(fresh.answers(next))
    }

    @Test fun noQuestionMeansNoCard() {
        val empty = keptQuestion(null, null)
        assertNull(empty.question)
        assertFalse(empty.closed)
    }

    @Test fun aKeptClosedCardCannotSendAndItsNoteWinsOverOfflineAndReplyNotes() {
        val ready = QuestionCard(question).choose(question, 0, "newest").choose(question, 1, "Docs")
        val kept = keptQuestion(question, null)
        assertFalse(ready.canSend(kept.question!!, offline = false, closed = kept.closed))
        assertFalse(ready.canSend(kept.question, offline = true, closed = kept.closed))
        assertEquals("Send, this question is closed", SEND_CLOSED)
        assertEquals(SEND_CLOSED, ready.sendDescription(kept.question, kept.closed))
        assertEquals("This question is closed.", QUESTION_CLOSED)
        for (offline in listOf(false, true)) {
            for (status in CardStatus.entries) assertEquals(QUESTION_CLOSED, ready.copy(status = status).note(offline, kept.closed))
        }
        assertEquals("Offline", ready.note(offline = true))
        assertFalse(ready.canSend(question, offline = true))
        assertNull(ready.sendDescription(question, closed = false))
    }

    @Test fun answerBodiesAndTheValidAnswerRule() {
        val empty = QuestionCard(question)
        assertNull(empty.answers(question))
        assertFalse(empty.canSend(question, offline = false))
        // A single-select answer alone is not enough while the multi-select question has nothing.
        val oneLabel = empty.choose(question, 0, " Oldest ")
        assertNull(oneLabel.answers(question))
        val twoLabels = oneLabel.choose(question, 1, "Lint").choose(question, 1, "Tests")
        assertEquals(listOf(PhoneAnswer(listOf(" Oldest ")), PhoneAnswer(listOf("Tests", "Lint"))), twoLabels.answers(question))
        // A second tap clears a multi-select label; nothing left there is no answer.
        assertNull(twoLabels.choose(question, 1, "Tests").choose(question, 1, "Lint").answers(question))
        // Other alone, and labels with Other.
        val otherOnly = empty.type(question, 0, "Ask me later").type(question, 1, "All of them")
        assertEquals(listOf(PhoneAnswer(emptyList(), "Ask me later"), PhoneAnswer(emptyList(), "All of them")), otherOnly.answers(question))
        val both = twoLabels.type(question, 1, "and the build")
        assertEquals(PhoneAnswer(listOf("Tests", "Lint"), "and the build"), both.answers(question)?.get(1))
        assertTrue(both.canSend(question, offline = false))
    }

    @Test fun singleSelectOtherAndOptionClearEachOther() {
        val typed = QuestionCard(question).choose(question, 0, "newest").type(question, 0, "Neither")
        assertEquals(emptyList<String>(), typed.selected[0])
        val chosen = typed.choose(question, 0, " Oldest ")
        assertEquals("", chosen.other[0])
        assertEquals(listOf(" Oldest "), chosen.selected[0])
        // Blank text counts as no text, so a single-select question with only spaces has no answer.
        assertNull(QuestionCard(question).type(question, 0, "  \u0001 ").choose(question, 1, "Docs").answers(question))
        // Multi-select keeps both.
        val multiBoth = QuestionCard(question).choose(question, 1, "Docs").type(question, 1, "More")
        assertEquals(listOf("Docs"), multiBoth.selected[1])
    }

    @Test fun otherTextIsCleanedAndLimited() {
        assertEquals("a\nb\tc", cleanOther("a\u0000\n\rb\u001b\t\u007fc"))
        val card = QuestionCard(question)
        assertEquals(OTHER_LIMIT, card.type(question, 1, "x".repeat(OTHER_LIMIT + 5)).other[1].length)
        // A cut never leaves half a surrogate pair.
        val emoji = "x".repeat(OTHER_LIMIT - 1) + "😀"
        assertEquals(OTHER_LIMIT - 1, card.type(question, 1, emoji).other[1].length)
        val sent = card.choose(question, 0, "newest").type(question, 1, "ok\u0007").answers(question)
        assertEquals("ok", sent?.get(1)?.other)
    }

    @Test fun theCardStates() {
        val ready = QuestionCard(question).choose(question, 0, "newest").choose(question, 1, "Docs")
        val sending = ready.sending()
        assertEquals("Sending", sending.note(false))
        assertFalse(sending.canSend(question, false))
        assertSame(sending, sending.choose(question, 0, " Oldest "))
        val sent = sending.replied(AnswerReply.Sent)
        assertEquals("Sent", sent.note(false))
        val closed = sending.replied(AnswerReply.Closed)
        assertEquals("Answered on the PC", closed.note(false))
        val off = sending.replied(AnswerReply.Off)
        assertEquals("Answers are off on the PC.", off.note(false))
        assertTrue(off.canSend(question, false))
        val refused = sending.replied(AnswerReply.Refused)
        assertEquals("The PC did not take this answer.", refused.note(false))
        assertTrue(refused.canSend(question, false))
        // A network error: Send works again; the inspector shows the error.
        val failed = sending.replied(null)
        assertEquals(CardStatus.Ready, failed.status)
        assertNull(failed.note(false))
        assertTrue(failed.canSend(question, false))
        // Offline blocks Send.
        assertFalse(ready.canSend(question, offline = true))
        assertEquals("Offline", ready.note(true))
        // A new request ID on the same row: the old choices do not answer it, and a new card starts empty.
        val next = question.copy(requestId = "f".repeat(32))
        assertNull(ready.answers(next))
        assertEquals(QuestionCard(next.requestId, listOf(emptyList(), emptyList()), listOf("", "")), QuestionCard(next))
    }

    @Test fun aNotificationTapOpensOnlyARowWithAQuestion() {
        val asking = Thread(id = "r1", globalId = "pc:r1", question = question)
        val plain = Thread(id = "r2", globalId = "pc:r2")
        val rows = listOf(asking, plain)
        assertEquals(asking, questionRowToOpen(notificationTag(asking.key, BIT_INPUT), rows))
        assertNull(questionRowToOpen(notificationTag(plain.key, BIT_INPUT), rows))
        assertNull(questionRowToOpen(notificationTag("gone", BIT_INPUT), rows))
        assertNull(questionRowToOpen("asb-status", rows))
    }
}
