package local.asb.companion

import kotlinx.serialization.encodeToString
import local.asb.companion.data.ApprovalItem
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Dashboard
import local.asb.companion.data.Mark
import local.asb.companion.data.PhoneApproval
import local.asb.companion.data.PhoneQuestion
import local.asb.companion.data.QuestionItem
import local.asb.companion.data.QuestionOption
import local.asb.companion.data.Thread
import local.asb.companion.net.AnswerReply
import local.asb.companion.net.Decision
import local.asb.companion.notify.BIT_INPUT
import local.asb.companion.notify.notificationTag
import local.asb.companion.notify.update
import local.asb.companion.ui.APPROVAL_CLOSED
import local.asb.companion.ui.ApprovalCard
import local.asb.companion.ui.ApprovalLabels
import local.asb.companion.ui.CardStatus
import local.asb.companion.ui.noteLabel
import local.asb.companion.ui.NOTE_LIMIT
import local.asb.companion.ui.answerRowToOpen
import local.asb.companion.ui.approvalBanner
import local.asb.companion.ui.approvalHeading
import local.asb.companion.ui.approvalLabels
import local.asb.companion.ui.approvalWins
import local.asb.companion.ui.keptApproval
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ApprovalCardTest {
    private val id = "0123456789abcdef0123456789abcdef"
    private val tool = PhoneApproval(id, "tool", "Bash", listOf(
        ApprovalItem("Command", "npm test -- --grep \"made up\"\n\tsecond line", mono = true),
        ApprovalItem("Description", "Run the made-up tests…")))
    private val plan = PhoneApproval("f".repeat(32), "plan", "Approve the plan?", listOf(ApprovalItem("Plan", "1. Read\n2. Write")), note = true)
    private val question = PhoneQuestion("e".repeat(32), listOf(QuestionItem("Pick?", options = listOf(QuestionOption("A")))))

    private fun row(json: String): Thread = AsbJson.decodeFromString<Dashboard>("""{"threads":[$json]}""").threads.single()

    private val toolJson = """{"requestId":"$id","kind":"tool","title":"Bash","display":[""" +
        """{"label":"Command","text":"npm test -- --grep \"made up\"\n\tsecond line","mono":true},""" +
        """{"label":"Description","text":"Run the made-up tests…","mono":false}],"note":false}"""

    @Test fun aValidApprovalDecodesAndNoneIsNull() {
        assertEquals(tool, row("""{"id":"one","approval":$toolJson}""").approval)
        assertNull(row("""{"id":"one"}""").approval)
        assertNull(row("""{"id":"one","approval":null}""").approval)
        // display and note may be missing; an empty display is valid.
        assertEquals(PhoneApproval(id, "plan", "Plan", emptyList(), false),
            row("""{"id":"one","approval":{"requestId":"$id","kind":"plan","title":"Plan","display":[]}}""").approval)
        // The sanity limits: 8 items, 16,000 per text, 32,000 together, title 300, label 40.
        val big = List(2) { """{"label":"${"L".repeat(40)}","text":"${"x".repeat(16_000)}"}""" }.joinToString(",")
        val atLimit = row("""{"id":"one","approval":{"requestId":"$id","kind":"tool","title":"${"T".repeat(300)}","display":[$big]}}""")
        assertEquals(2, atLimit.approval?.display?.size)
        val eight = List(8) { """{"label":"L$it","text":""}""" }.joinToString(",")
        assertEquals(8, row("""{"id":"one","approval":{"requestId":"$id","kind":"tool","title":"T","display":[$eight]}}""").approval?.display?.size)
    }

    @Test fun aMalformedApprovalIsNullAndTheRowStays() {
        fun approval(requestId: String = "\"$id\"", kind: String = "\"tool\"", title: String = "\"Bash\"", display: String = "[]",
                     note: String = "false") =
            """{"requestId":$requestId,"kind":$kind,"title":$title,"display":$display,"note":$note}"""
        val item = """{"label":"Command","text":"ls"}"""
        val cases = listOf(
            "\"text\"", "[]", "5",
            approval(requestId = "\"${"A".repeat(32)}\""), approval(requestId = "\"abc\""), approval(requestId = "7"),
            approval(kind = "\"question\""), approval(kind = "\"Tool\""), approval(kind = "1"),
            approval(title = "\"\""), approval(title = "\"${"T".repeat(301)}\""), approval(title = "null"),
            approval(display = "[${List(9) { item }.joinToString(",")}]"), approval(display = "{}"), approval(display = "[5]"),
            approval(display = """[{"label":"","text":"ls"}]"""), approval(display = """[{"label":"${"L".repeat(41)}","text":"ls"}]"""),
            approval(display = """[{"label":"Command"}]"""), approval(display = """[{"label":"Command","text":3}]"""),
            approval(display = """[{"label":"Command","text":"${"x".repeat(16_001)}"}]"""),
            approval(display = List(3) { """{"label":"L","text":"${"x".repeat(11_000)}"}""" }.joinToString(",", "[", "]")),
            approval(display = """[{"label":"Command","text":"ls","mono":"true"}]"""),
            approval(note = "\"true\""), approval(note = "1"),
            """{"kind":"tool","title":"Bash"}""",
        )
        for (case in cases) {
            val row = row("""{"id":"one","title":"Kept","approval":$case,"questionAttention":true}""")
            assertNull(case, row.approval)
            assertEquals("Kept", row.title)
            assertTrue(row.questionAttention)
        }
    }

    @Test fun theSavedBaselineHasNoApprovalText() {
        val saved = AsbJson.encodeToString(update(null, listOf(row("""{"id":"one","questionAttention":true,"approval":$toolJson}""")), 1000))
        assertEquals(id, AsbJson.decodeFromString<Map<String, Mark>>(saved).getValue("one").requestId)
        for (text in listOf("npm test", "made-up tests", "Command")) assertFalse(text, saved.contains(text))
    }

    @Test fun theCardLinesOfAToolAndAPlan() {
        assertEquals(ApprovalLabels("Deny", "Allow once"), approvalLabels(tool))
        assertEquals(ApprovalLabels("Keep planning", "Approve plan"), approvalLabels(plan))
        assertEquals("Approval request: Bash", approvalHeading(tool))
        assertEquals("Approval request: Approve the plan?", approvalHeading(plan))
        assertEquals("Note for the agent (sent with Deny)", noteLabel(tool))
        assertEquals("Note for the agent (sent with Keep planning)", noteLabel(plan))
        assertEquals("Allow once, this request is closed", ApprovalCard(tool).allowDescription(tool, closed = true))
        assertEquals("Approve plan, this request is closed", ApprovalCard(plan).allowDescription(plan, closed = true))
        assertNull(ApprovalCard(tool).allowDescription(tool, closed = false))
    }

    @Test fun theNoteRules() {
        val typed = ApprovalCard(plan).type("Keep\u0007 step\u0000 2\n\tonly")
        assertEquals("Keep step 2\n\tonly", typed.noteFor(plan, Decision.Deny))
        // Only with a deny, only when the approval takes a note, never blank.
        assertNull(typed.noteFor(plan, Decision.Allow))
        assertNull(ApprovalCard(tool).type("A note").noteFor(tool, Decision.Deny))
        assertNull(ApprovalCard(plan).type(" \u0001\n").noteFor(plan, Decision.Deny))
        assertEquals(NOTE_LIMIT, ApprovalCard(plan).type("x".repeat(NOTE_LIMIT + 9)).note.length)
        assertEquals(500, NOTE_LIMIT)
        // A cut never leaves half a surrogate pair.
        assertEquals(NOTE_LIMIT - 1, ApprovalCard(plan).type("x".repeat(NOTE_LIMIT - 1) + "😀").note.length)
        // No typing while the decision is sent.
        val sending = typed.sending()
        assertSame(sending, sending.type("Other"))
    }

    @Test fun buttonsWaitForArmingAndANewRequestStartsUnarmed() {
        val first = ApprovalCard(tool)
        assertFalse(first.armed)
        assertFalse(first.canDecide(offline = false))
        assertFalse(first.canDecide(offline = false, closed = false, armed = false))
        assertEquals("Usable before arming", first.type("Usable before arming").note)
        val armed = first.arm()
        assertTrue(armed.canDecide(offline = false))
        assertFalse(armed.canDecide(offline = true))
        assertFalse(armed.canDecide(offline = false, closed = true))
        val next = ApprovalCard(tool.copy(requestId = "a".repeat(32)))
        assertFalse(next.armed)
        assertFalse(next.canDecide(offline = false))
    }

    @Test fun theCardStates() {
        val ready = ApprovalCard(plan).arm().type("Private note")
        assertTrue(ready.canDecide(offline = false))
        assertNull(ready.line(false))
        val sending = ready.sending()
        assertFalse(sending.canDecide(offline = false))
        assertEquals("Sending", sending.line(false))
        val sent = sending.replied(AnswerReply.Sent)
        assertEquals(CardStatus.Sent, sent.status)
        assertFalse(sent.canDecide(false))
        assertEquals("", sent.note)
        val closed = sending.replied(AnswerReply.Closed)
        assertEquals("Answered on the PC", closed.line(false))
        assertFalse(closed.canDecide(false))
        assertEquals("", closed.note)
        val off = sending.replied(AnswerReply.Off)
        assertEquals("Approvals are off on the PC.", off.line(false))
        assertTrue(off.canDecide(false))
        val refused = sending.replied(AnswerReply.Refused)
        assertEquals("The PC did not take this answer.", refused.line(false))
        assertTrue(refused.canDecide(false))
        // A network error: the buttons work again, the note stays.
        val failed = sending.replied(null)
        assertEquals(CardStatus.Ready, failed.status)
        assertEquals("Private note", failed.note)
        assertTrue(failed.canDecide(false))
        // Offline: both buttons off.
        assertFalse(ready.canDecide(offline = true))
        assertEquals("Offline", ready.line(true))
        // A new request ID starts a new card.
        assertEquals(ApprovalCard(tool.requestId), ApprovalCard(tool))
        assertFalse(ApprovalCard(tool) == ApprovalCard(plan))
    }

    @Test fun theBannersOfEachKindAndReply() {
        assertEquals("Allowed", approvalBanner(AnswerReply.Sent, Decision.Allow, plan = false))
        assertEquals("Denied", approvalBanner(AnswerReply.Sent, Decision.Deny, plan = false))
        assertEquals("Plan approved", approvalBanner(AnswerReply.Sent, Decision.Allow, plan = true))
        assertEquals("Kept planning", approvalBanner(AnswerReply.Sent, Decision.Deny, plan = true))
        for (decision in Decision.entries) {
            assertEquals("Answered on the PC", approvalBanner(AnswerReply.Closed, decision, plan = false))
            assertNull(approvalBanner(AnswerReply.Off, decision, plan = true))
            assertNull(approvalBanner(AnswerReply.Refused, decision, plan = false))
        }
    }

    @Test fun anApprovalThatLeavesTheRowStaysClosedInPlace() {
        val live = keptApproval(null, tool)
        assertSame(tool, live.approval)
        assertFalse(live.closed)
        val kept = keptApproval(live.approval, null)
        assertSame(tool, kept.approval)
        assertTrue(kept.closed)
        assertEquals(APPROVAL_CLOSED, ApprovalCard(tool).line(offline = true, closed = true))
        assertEquals("This request is closed.", APPROVAL_CLOSED)
        for (status in CardStatus.entries) assertEquals(APPROVAL_CLOSED, ApprovalCard(tool).copy(status = status).line(false, closed = true))
        assertFalse(ApprovalCard(tool).canDecide(offline = false, closed = true))
        // A new request replaces the kept one, open.
        val replaced = keptApproval(tool, plan)
        assertSame(plan, replaced.approval)
        assertFalse(replaced.closed)
        assertNull(keptApproval(null, null).approval)
    }

    @Test fun theApprovalCardWinsOverAQuestion() {
        assertTrue(approvalWins(keptApproval(null, tool), question))
        assertTrue(approvalWins(keptApproval(tool, null), null))
        // A closed approval gives way to a live question.
        assertFalse(approvalWins(keptApproval(tool, null), question))
        assertFalse(approvalWins(keptApproval(null, null), question))
        val both = row("""{"id":"one","approval":$toolJson,"question":{"requestId":"${"e".repeat(32)}","questions":""" +
            """[{"question":"Pick?","options":[{"label":"A"}]}]}}""")
        assertEquals(tool, both.approval)
        assertTrue(approvalWins(keptApproval(null, both.approval), both.question))
    }

    @Test fun aNotificationTapOpensARowWithAQuestionOrAnApproval() {
        val approving = Thread(id = "r1", globalId = "pc:r1", approval = tool)
        val asking = Thread(id = "r3", globalId = "pc:r3", question = question)
        val plain = Thread(id = "r2", globalId = "pc:r2")
        val rows = listOf(approving, plain, asking)
        assertEquals(approving, answerRowToOpen(notificationTag(approving.key, BIT_INPUT), rows))
        assertEquals(asking, answerRowToOpen(notificationTag(asking.key, BIT_INPUT), rows))
        assertNull(answerRowToOpen(notificationTag(plain.key, BIT_INPUT), rows))
        assertNull(answerRowToOpen(notificationTag("gone", BIT_INPUT), rows))
        assertNull(answerRowToOpen("asb-status", rows))
    }
}
