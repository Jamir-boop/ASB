package local.asb.companion

import java.net.InetAddress
import java.security.SecureRandom
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import local.asb.companion.data.AsbJson
import local.asb.companion.data.ChatTurn
import local.asb.companion.data.Endpoint
import local.asb.companion.data.Hello
import local.asb.companion.data.Thread
import local.asb.companion.data.parseChat
import local.asb.companion.net.AsbApi
import local.asb.companion.net.MemoryPaths
import local.asb.companion.net.MessageReply
import local.asb.companion.net.sha256Hex
import local.asb.companion.ui.Composer
import local.asb.companion.ui.ComposerStatus
import local.asb.companion.ui.MESSAGE_FAILED
import local.asb.companion.ui.MESSAGE_LIMIT
import local.asb.companion.ui.MESSAGE_SENT
import local.asb.companion.ui.MESSAGE_SENT_WORKING
import local.asb.companion.ui.MESSAGE_SENDING
import local.asb.companion.ui.PHONE_TURN_LABEL
import local.asb.companion.ui.messageReasonLine
import local.asb.companion.ui.newMessageId
import local.asb.companion.ui.phoneTurnText
import local.asb.companion.ui.refreshAfterSend
import local.asb.companion.ui.takeCodePoints
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

// The P2 composer: the row fields, the hello switch, the state machine, the limits, the reply mapping, and the phone turn.
class ComposerTest {
    private lateinit var server: MockWebServer
    private lateinit var fingerprint: String
    private val messageId = "0123456789abcdef0123456789abcdef"

    @Before fun start() {
        val certificate = HeldCertificate.Builder().commonName("ASB composer test").ecdsa256().build()
        fingerprint = sha256Hex(certificate.certificate.encoded)
        server = MockWebServer().apply {
            useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
            start(InetAddress.getByName("127.0.0.1"), 0)
        }
    }

    @After fun stop() = server.shutdown()

    private fun api() = AsbApi(MemoryPaths(listOf(Endpoint("lan", "127.0.0.1"))), server.port, fingerprint, "t".repeat(43))

    private fun reply(code: Int, error: String) = MockResponse().setResponseCode(code).setBody("""{"error":"$error"}""")

    @Test fun theRowFieldsAndTheHelloSwitchParseAndAnOlderPcSendsNeither() {
        val row = AsbJson.decodeFromString<Thread>("""{"id":"cl/1","canMessage":false,"messageReason":"not-live"}""")
        assertEquals(false, row.canMessage)
        assertEquals("not-live", row.messageReason)
        assertEquals(true, AsbJson.decodeFromString<Thread>("""{"id":"cl/1","canMessage":true}""").canMessage)
        // An older engine sends neither field: the app shows no composer, and no reason line.
        val old = AsbJson.decodeFromString<Thread>("""{"id":"cl/1"}""")
        assertNull(old.canMessage)
        assertEquals("", old.messageReason)
        assertTrue(AsbJson.decodeFromString<Hello>("""{"api":1,"message":true}""").message)
        assertFalse(AsbJson.decodeFromString<Hello>("""{"api":1}""").message)
    }

    @Test fun theReasonLinesAreTheContractLines() {
        assertEquals("Open the session on the PC to send a message.", messageReasonLine("not-live"))
        assertEquals("The ASB message relay is not running on the PC.", messageReasonLine("relay"))
        // Unsupported shows no line and no composer; an unknown code shows nothing.
        assertNull(messageReasonLine("unsupported"))
        assertNull(messageReasonLine(""))
    }

    @Test fun theStateMachineKeepsTheDraftAndTheIdWhenAFailureIsRetried() {
        val ready = Composer(messageId = messageId)
        assertEquals(ComposerStatus.Ready, ready.status)
        assertFalse(ready.canSend())
        val typed = ready.type("Hello")
        assertEquals("Hello", typed.draft)
        assertEquals(messageId, typed.messageId)
        assertTrue(typed.canSend())
        // Sending locks the field and the button; it can send no second time.
        val sending = typed.sending()
        assertEquals(ComposerStatus.Sending, sending.status)
        assertFalse(sending.canSend())
        // A typed change while Sending changes nothing.
        assertEquals(sending, sending.type("Changed while sending"))
        // Failed keeps the draft and the ID, so Retry sends the same message once.
        val failed = sending.replied(MessageReply.Failed)
        assertEquals(ComposerStatus.Failed, failed.status)
        assertEquals("Hello", failed.draft)
        assertEquals(messageId, failed.messageId)
        assertEquals(MESSAGE_FAILED, failed.note(false))
        assertTrue(failed.canSend())
        // Retry sends the same ID.
        assertEquals(messageId, failed.sending().messageId)
        // A refusal shows the server text and keeps the draft.
        val refused = sending.replied(MessageReply.Refused("This message is being sent."))
        assertEquals(ComposerStatus.Refused, refused.status)
        assertEquals("This message is being sent.", refused.note(false))
        assertEquals("Hello", refused.draft)
        // An edit after a refusal is a new draft with a new ID, so the PC never answers it with the old stored reply.
        val edited = refused.type("Hello again")
        assertEquals(ComposerStatus.Ready, edited.status)
        assertNotEquals(messageId, edited.messageId)
        assertNull(edited.note(false))
    }

    @Test fun sentClearsTheFieldAndNamesTheWorkingWait() {
        val sent = Composer(draft = "Hi", messageId = messageId, status = ComposerStatus.Sending).replied(MessageReply.Sent)
        assertEquals(ComposerStatus.Sent, sent.status)
        assertEquals("", sent.draft)
        assertNotEquals(messageId, sent.messageId)
        assertEquals(MESSAGE_SENT, sent.note(false))
        assertEquals(MESSAGE_SENT_WORKING, sent.note(true))
        // There is no Delivered state: Sent is the last one and the turn in the chat is the proof.
        assertEquals(ComposerStatus.entries.map { it.name },
            listOf("Ready", "Sending", "Sent", "Failed", "Refused"))
        // A null reply (a network error) is Failed, as the contract maps it.
        assertEquals(ComposerStatus.Failed, Composer(draft = "x").sending().replied(null).status)
        assertEquals(MESSAGE_SENDING, Composer(draft = "x").sending().note(false))
    }

    @Test fun theLimitIsFourThousandCodePointsAndCountsAstralCharacters() {
        // 4,000 astral characters are 8,000 UTF-16 units: an over-limit, not a 0-limit cut.
        val astral = "😀".repeat(MESSAGE_LIMIT)
        assertEquals(MESSAGE_LIMIT, astral.codePointCount(0, astral.length))
        assertEquals(2 * MESSAGE_LIMIT, astral.length)
        assertEquals(astral, takeCodePoints(astral, MESSAGE_LIMIT))
        val composer = Composer().type(astral)
        assertEquals(astral, composer.draft)
        // One more astral character is cut whole, never as half a pair.
        val over = composer.type(astral + "😀")
        assertEquals(astral, over.draft)
        // A BMP text over the limit is cut at 4,000.
        assertEquals(MESSAGE_LIMIT, "x".repeat(5_000).let { takeCodePoints(it, MESSAGE_LIMIT) }.length)
    }

    @Test fun aNewIdIs32LowercaseHexAndUnique() {
        val random = SecureRandom(byteArrayOf(1, 2, 3))
        val first = newMessageId(random)
        assertTrue(first.matches(Regex("[0-9a-f]{32}")))
        assertNotEquals(first, newMessageId())
        assertNotEquals(newMessageId(), newMessageId())
    }

    @Test fun theSendBodyHasTheIdAndTheTextAndMapsEachReply() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"sent":true}"""))
        assertEquals(MessageReply.Sent, api().sendMessage("cl/1", messageId, "Hi \"there\"\nnow", ""))
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/phone/v1/threads/cl%2F1/message", request.path)
        assertEquals("""{"messageId":"$messageId","text":"Hi \"there\"\nnow"}""", request.body.readUtf8())
        // 400, 404, 409, 413, and 429 keep the server text, as it is.
        for ((code, text) in listOf(400 to "Invalid message.", 404 to "Route is not available.",
            409 to "Open the session on the PC to send a message.", 413 to "The message is too long.",
            429 to "Too many messages. Try again in a minute.")) {
            server.enqueue(reply(code, text))
            assertEquals(MessageReply.Refused(text), api().sendMessage("one", messageId, "Hi", ""))
        }
        // A 5xx is Failed, so Retry keeps the draft.
        server.enqueue(reply(500, "Cannot send now."))
        assertEquals(MessageReply.Failed, api().sendMessage("one", messageId, "Hi", ""))
        // A bad session ID never reaches the PC.
        assertEquals(MessageReply.Refused("Invalid session ID."), api().sendMessage("..", messageId, "Hi", ""))
    }

    @Test fun aTimeoutIsFailed() = runBlocking {
        // 192.0.2.1 is TEST-NET-1 and is never routed, so the connect timeout fires as a network error.
        val timeout = AsbApi(MemoryPaths(listOf(Endpoint("lan", "192.0.2.1"))), server.port, fingerprint, "t".repeat(43))
        assertEquals(MessageReply.Failed, timeout.sendMessage("one", messageId, "Hi", ""))
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test fun aSentMessageReadsTheChatAtOnceAndAgainAfterTwoSeconds() = runTest {
        var reads = 0
        launch { refreshAfterSend { reads++ } }
        runCurrent()
        assertEquals(1, reads)
        advanceTimeBy(1_999)
        runCurrent()
        assertEquals(1, reads)
        advanceTimeBy(2)
        runCurrent()
        assertEquals(2, reads)
    }

    @Test fun aPhoneTurnIsOnTheUserSideWithTheLabelAndWithoutItsFirstLine() {
        val turn = parseChat(AsbJson.parseToJsonElement(
            """{"turns":[{"role":"peer","name":"Phone","text":"[Sent from the owner's phone (Pixel) through ASB.]\nLook at the build",
                "atMs":1,"cut":false,"fromPhone":true}],"more":false}"""))!!.turns.single()
        assertTrue(turn.fromPhone)
        assertEquals("Look at the build", phoneTurnText(turn.text))
        assertEquals(PHONE_TURN_LABEL, "You, from the phone")
        // A peer turn without the field is a plain peer turn; a text with no line keeps nothing after the cut.
        assertEquals(false, ChatTurn("peer", "Phone", "x", 1, false).fromPhone)
        assertEquals("", phoneTurnText("No first line"))
        // A phone turn keeps the label only: the peer name is not shown for it.
        assertNotEquals(turn.name, PHONE_TURN_LABEL)
    }
}
