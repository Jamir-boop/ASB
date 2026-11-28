package local.asb.companion

import java.net.InetAddress
import kotlinx.coroutines.runBlocking
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Dashboard
import local.asb.companion.data.Endpoint
import local.asb.companion.data.PhoneAnswer
import local.asb.companion.data.PhoneQuestion
import local.asb.companion.data.QuestionItem
import local.asb.companion.data.QuestionOption
import local.asb.companion.net.AnswerReply
import local.asb.companion.net.AsbApi
import local.asb.companion.net.MemoryPaths
import local.asb.companion.net.sha256Hex
import local.asb.companion.ui.CardStatus
import local.asb.companion.ui.NEXT_STEP_HELP
import local.asb.companion.ui.NEXT_STEP_OTHER_LIMIT
import local.asb.companion.ui.NEXT_STEP_UNAVAILABLE
import local.asb.companion.ui.OTHER_LIMIT
import local.asb.companion.ui.QuestionCard
import local.asb.companion.ui.nextStepActionLines
import local.asb.companion.ui.nextStepBlocked
import local.asb.companion.ui.nextStepUnavailable
import local.asb.companion.ui.otherLimit
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The next-step card of a Claude Desktop Code row: the parser, the card, and the reply mapping. */
class NextStepCardTest {
    private val id = "0123456789abcdef0123456789abcdef"
    private val next = PhoneQuestion(id, listOf(QuestionItem("Ship it?", options = listOf(QuestionOption("Commit"), QuestionOption("Push")))),
        kind = "next-step")
    private val hook = PhoneQuestion(id, listOf(QuestionItem("Which order?", options = listOf(QuestionOption("Oldest")))))

    private lateinit var server: MockWebServer
    private lateinit var fingerprint: String

    @Before fun start() {
        val certificate = HeldCertificate.Builder().commonName("ASB next-step test").ecdsa256().build()
        fingerprint = sha256Hex(certificate.certificate.encoded)
        server = MockWebServer().apply {
            useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
            start(InetAddress.getByName("127.0.0.1"), 0)
        }
    }

    @After fun stop() = server.shutdown()

    private fun api() = AsbApi(MemoryPaths(listOf(Endpoint("lan", "127.0.0.1"))), server.port, fingerprint, "t".repeat(43))

    private fun reply(code: Int, error: String) = MockResponse().setResponseCode(code).setBody("""{"error":"$error"}""")

    private fun question(json: String): PhoneQuestion? =
        AsbJson.decodeFromString<Dashboard>("""{"threads":[{"id":"one","question":$json}]}""").threads.single().question

    private fun body(fields: String = "") =
        """{"requestId":"$id","kind":"next-step","questions":[{"question":"Ship it?","options":[{"label":"Commit"},{"label":"Push"}]}]$fields}"""

    // The parser.

    @Test fun theNewFieldsAreReadAndDefault() {
        assertEquals(PhoneQuestion(id, listOf(QuestionItem("Ship it?", options = emptyList())), "next-step", true, "", emptyList()),
            question("""{"requestId":"$id","kind":"next-step","questions":[{"question":"Ship it?","options":[]}]}"""))
        // No kind at all: the hook card, with live true and no app actions.
        assertEquals(PhoneQuestion(id, listOf(QuestionItem("Ship it?", options = listOf(QuestionOption("Commit")))), "", true, "", emptyList()),
            question("""{"requestId":"$id","questions":[{"question":"Ship it?","options":[{"label":"Commit"}]}]}"""))
        val full = question(body(""","live":false,"unavailable":"Open the session on the PC to answer.","appActions":["Commit"]"""))
        assertEquals("next-step", full?.kind)
        assertFalse(full!!.live)
        assertEquals("Open the session on the PC to answer.", full.unavailable)
        assertEquals(listOf("Commit"), full.appActions)
        // The hook kind keeps its fields and defaults.
        val old = question("""{"requestId":"$id","questions":[{"question":"Which order?","options":[{"label":"Oldest"}]}]}""")
        assertEquals("", old?.kind)
        assertTrue(old!!.live)
        assertEquals("", old.unavailable)
        assertEquals(emptyList<String>(), old.appActions)
    }

    @Test fun aBadNewFieldDropsOnlyThatField() {
        val option = """"questions":[{"question":"Ship it?","options":[{"label":"Commit"}]}]"""
        val base = """{"requestId":"$id","kind":"next-step",$option"""
        // A bad live value falls back to true; a bad appActions value to empty. The card stays.
        for (bad in listOf("\"true\"", "1", "null", "[]", "{}")) {
            val card = question("""$base,"live":$bad}""")
            assertEquals(bad, true, card?.live)
            assertEquals("Ship it?", card?.questions?.single()?.question)
        }
        for (bad in listOf("\"Commit\"", "{}", "[5]", """[""]""", "[null]", """["${"x".repeat(201)}"]""",
            """["A","A"]""", "[" + List(9) { "\"A$it\"" }.joinToString(",") + "]")) {
            val card = question("""$base,"appActions":$bad}""")
            assertEquals(bad, emptyList<String>(), card?.appActions)
            assertEquals("Ship it?", card?.questions?.single()?.question)
        }
        // An empty options list is fine for a next-step question (only Other), but not for the hook kind.
        val empty = """{"requestId":"$id","kind":"next-step","questions":[{"question":"Ship it?","options":[]}]}"""
        assertEquals(emptyList<QuestionOption>(), question(empty)?.questions?.single()?.options)
        assertNull(question(empty.replace("\"kind\":\"next-step\",", "")))
    }

    @Test fun theParserLimitsAreTheEngines() {
        val actions = "[" + List(8) { "\"A$it\"" }.joinToString(",") + "]"
        assertEquals(8, question(body(""","appActions":$actions"""))?.appActions?.size)
        assertEquals(listOf("Commit"), question(body(""","appActions":["  Commit  "]"""))?.appActions)
    }

    // The card.

    @Test fun theOtherLimitIsWiderForANextStepReply() {
        assertEquals(NEXT_STEP_OTHER_LIMIT, otherLimit(next))
        assertEquals(OTHER_LIMIT, otherLimit(hook))
        assertEquals(4_000, NEXT_STEP_OTHER_LIMIT)
        val card = QuestionCard(next)
        assertEquals(NEXT_STEP_OTHER_LIMIT, card.type(next, 0, "x".repeat(NEXT_STEP_OTHER_LIMIT + 5)).other[0].length)
        assertEquals(OTHER_LIMIT, QuestionCard(hook).type(hook, 0, "x".repeat(OTHER_LIMIT + 5)).other[0].length)
    }

    @Test fun aNextStepReplyHasOneAnswerItemAndStillNeedsOne() {
        val card = QuestionCard(next)
        assertNull(card.answers(next))
        val labelled = card.choose(next, 0, "Commit")
        assertEquals(listOf(PhoneAnswer(listOf("Commit"))), labelled.answers(next))
        val typed = card.type(next, 0, "Ship it now")
        assertEquals(listOf(PhoneAnswer(emptyList(), "Ship it now")), typed.answers(next))
    }

    @Test fun theAppActionLinesAndTheHelpLineArePlainText() {
        val card = next.copy(appActions = listOf("Commit", "Run the tests"))
        assertEquals(listOf("On the PC: Commit", "On the PC: Run the tests"), nextStepActionLines(card))
        assertEquals(emptyList<String>(), nextStepActionLines(next))
        assertEquals("The agent gets this as a message from your phone. For risky steps it can still ask on the PC.", NEXT_STEP_HELP)
    }

    @Test fun aNotLiveNextStepHasNoSend() {
        val blocked = next.copy(live = false)
        assertTrue(nextStepBlocked(blocked))
        assertFalse(nextStepBlocked(next))
        assertFalse(nextStepBlocked(hook))
        // The PC cannot take it: the card shows only its words, so it never reaches Send.
        assertNull(QuestionCard(blocked).answers(blocked))
        assertEquals(NEXT_STEP_UNAVAILABLE, nextStepUnavailable(blocked))
        assertEquals("Open the session on the PC to answer.", NEXT_STEP_UNAVAILABLE)
        assertEquals("Answer on the PC: the ASB message relay is not running.",
            nextStepUnavailable(blocked.copy(unavailable = "Answer on the PC: the ASB message relay is not running.")))
    }

    @Test fun aServerTextStaysOnTheCardAsItIs() {
        val sending = QuestionCard(next).choose(next, 0, "Commit").sending()
        val already = sending.replied(AnswerReply.Text("Already answered."))
        assertEquals(CardStatus.ServerText, already.status)
        assertEquals("Already answered.", already.note(false))
        assertTrue(already.canSend(next, offline = false))
        assertEquals("Too many answers. Try again in a minute.", sending.replied(AnswerReply.Text("Too many answers. Try again in a minute.")).note(false))
        // A later reply clears the text.
        assertEquals("", already.replied(AnswerReply.Sent).serverText)
        assertEquals("Sent", already.replied(AnswerReply.Sent).note(false))
    }

    // The reply mapping.

    @Test fun aNextStepReplyShowsTheServerTextOfA409AndA429() = runBlocking {
        val one = listOf(PhoneAnswer(listOf("Commit")))
        server.enqueue(MockResponse().setBody("""{"answered":true}"""))
        assertEquals(AnswerReply.Sent, api().answer("one", id, one, "", nextStep = true))
        for (text in listOf("Already answered.", "Open the session on the PC to answer.",
            "Cannot send now: the ASB message relay is not running on the PC.", "Cannot send now. Answer on the PC.")) {
            server.enqueue(reply(409, text))
            assertEquals(AnswerReply.Text(text), api().answer("one", id, one, "", nextStep = true))
        }
        server.enqueue(reply(429, "Too many answers. Try again in a minute."))
        assertEquals(AnswerReply.Text("Too many answers. Try again in a minute."),
            api().answer("one", id, one, "", nextStep = true))
    }

    @Test fun theHookKindsKeepTheirMapping() = runBlocking {
        val one = listOf(PhoneAnswer(listOf("Oldest")))
        server.enqueue(reply(409, "This question is closed."))
        assertEquals(AnswerReply.Closed, api().answer("one", id, one, ""))
        server.enqueue(reply(400, "Invalid answer."))
        assertEquals(AnswerReply.Refused, api().answer("one", id, one, ""))
        // A 429 of the hook kind is still the app's throttle error, not a card text.
        server.enqueue(reply(429, "Too many answers."))
        try {
            api().answer("one", id, one, "")
            org.junit.Assert.fail("Expected a throttle error")
        } catch (cause: local.asb.companion.net.AsbError) {
            assertTrue(cause === local.asb.companion.net.AsbError.Throttled)
        }
    }
}
