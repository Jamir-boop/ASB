package local.asb.companion

import java.net.InetAddress
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import local.asb.companion.data.AsbJson
import local.asb.companion.data.ChatReply
import local.asb.companion.data.ChatTurn
import local.asb.companion.data.Endpoint
import local.asb.companion.data.Thread
import local.asb.companion.data.parseChat
import local.asb.companion.net.AsbApi
import local.asb.companion.net.MemoryPaths
import local.asb.companion.net.NO_CHAT
import local.asb.companion.net.ROUTE_NOT_AVAILABLE
import local.asb.companion.net.sha256Hex
import local.asb.companion.ui.CHAT_FAILED
import local.asb.companion.ui.CHAT_NONE
import local.asb.companion.ui.CHAT_OFF
import local.asb.companion.ui.CHAT_OLDER
import local.asb.companion.ui.CHAT_POLL_MS
import local.asb.companion.ui.ChatState
import local.asb.companion.ui.chatOffered
import local.asb.companion.ui.chatPolls
import local.asb.companion.ui.chatStateAfter
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

// The chat view (P1 contract): the strict parser, the reply mapping, the Chat button rule, and the poll state.
class ChatScreenTest {
    private lateinit var server: MockWebServer
    private lateinit var fingerprint: String

    @Before fun start() {
        val certificate = HeldCertificate.Builder().commonName("ASB chat test").ecdsa256().build()
        fingerprint = sha256Hex(certificate.certificate.encoded)
        server = MockWebServer().apply {
            useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
            start(InetAddress.getByName("127.0.0.1"), 0)
        }
    }

    @After fun stop() = server.shutdown()

    private fun api() = AsbApi(MemoryPaths(listOf(Endpoint("lan", "127.0.0.1"))), server.port, fingerprint, "t".repeat(43))

    private val sample = """{"api":1,"threadId":"cl/1","turns":[""" +
        """{"role":"user","text":"Ask one","atMs":1795832380317,"cut":false},""" +
        """{"role":"assistant","text":"Answer one","atMs":1795832381317,"cut":true},""" +
        """{"role":"peer","name":"docs","text":"A message from docs","atMs":1795832382317,"cut":false}],"more":true}"""

    private fun reply(code: Int, error: String) = MockResponse().setResponseCode(code).setBody("""{"error":"$error"}""")

    @Test fun theParserKeepsAllThreeRolesCutAndMore() {
        val chat = parseChat(AsbJson.parseToJsonElement(sample))!!
        assertEquals(listOf("user", "assistant", "peer"), chat.turns.map { it.role })
        assertEquals(ChatTurn("user", "", "Ask one", 1795832380317, false), chat.turns[0])
        assertEquals(ChatTurn("assistant", "", "Answer one", 1795832381317, true), chat.turns[1])
        assertEquals(ChatTurn("peer", "docs", "A message from docs", 1795832382317, false), chat.turns[2])
        assertTrue(chat.more)
        // More absent or a string is no reply.
        assertNull(parseChat(AsbJson.parseToJsonElement("""{"turns":[]}""")))
        assertNull(parseChat(AsbJson.parseToJsonElement("""{"turns":[],"more":"true"}""")))
    }

    @Test fun aPeerWithoutANameAndAnUnknownRoleDropOnlyThatTurn() {
        val body = """{"turns":[""" +
            """{"role":"peer","text":"No name","atMs":1,"cut":false},""" +
            """{"role":"system","text":"Unknown role","atMs":2,"cut":false},""" +
            """{"role":"user","atMs":3,"cut":false},""" +
            """{"role":"assistant","text":"Kept","atMs":4,"cut":false}],"more":false}"""
        val chat = parseChat(AsbJson.parseToJsonElement(body))!!
        assertEquals(listOf("Kept"), chat.turns.map { it.text })
        assertFalse(chat.more)
    }

    @Test fun chatAsksForTheRowAndDefaultLimit() = runBlocking {
        server.enqueue(MockResponse().setBody(sample))
        val result = api().chat("cl/1", "")
        assertEquals(AsbApi.ChatResult.Shown(parseChat(AsbJson.parseToJsonElement(sample))!!), result)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/phone/v1/threads/cl%2F1/chat?limit=30", request.path)
        assertEquals("Bearer ${"t".repeat(43)}", request.getHeader("Authorization"))
    }

    @Test fun eachReplyMapsToItsChatState() = runBlocking {
        server.enqueue(MockResponse().setBody(sample))
        assertTrue(api().chat("one", "") is AsbApi.ChatResult.Shown)
        server.enqueue(reply(404, ROUTE_NOT_AVAILABLE))
        assertEquals(AsbApi.ChatResult.Off, api().chat("one", ""))
        server.enqueue(reply(404, NO_CHAT))
        assertEquals(AsbApi.ChatResult.NoChat, api().chat("one", ""))
        // Any other 404, a 500, and a bad body are Failed.
        server.enqueue(reply(404, "ASB session not found."))
        assertEquals(AsbApi.ChatResult.Failed, api().chat("one", ""))
        server.enqueue(reply(500, "Cannot read the chat."))
        assertEquals(AsbApi.ChatResult.Failed, api().chat("one", ""))
        server.enqueue(MockResponse().setBody("""{"turns":"x"}"""))
        assertEquals(AsbApi.ChatResult.Failed, api().chat("one", ""))
    }

    @Test fun aTimeoutIsFailed() = runBlocking {
        // 192.0.2.1 is TEST-NET-1 and is never routed, so the 3 s connect timeout fires: a SocketTimeoutException, as a network error.
        val timeout = AsbApi(MemoryPaths(listOf(Endpoint("lan", "192.0.2.1"))), server.port, fingerprint, "t".repeat(43))
        assertEquals(AsbApi.ChatResult.Failed, timeout.chat("one", ""))
    }

    @Test fun theChatButtonNeedsTheSwitchTheProviderAndALocalRow() {
        val row = Thread(id = "local_1", provider = "claude-desktop-code")
        assertTrue(chatOffered(row, true))
        // The switch off or absent (an older PC) offers no Chat.
        assertFalse(chatOffered(row, false))
        assertFalse(chatOffered(row, null))
        // Another provider or a member row offers no Chat.
        assertFalse(chatOffered(row.copy(provider = "codex"), true))
        assertFalse(chatOffered(row.copy(id = "m:aaaaaaaaaaaaaaaa:claude-desktop-code:1"), true))
    }

    @Test fun offDropsTheTurnsAndFailedKeepsThem() {
        val shown = ChatState(reply = parseChat(AsbJson.parseToJsonElement(sample)))
        assertEquals(ChatState(off = true), chatStateAfter(shown, AsbApi.ChatResult.Off))
        assertEquals(ChatState(none = true), chatStateAfter(shown, AsbApi.ChatResult.NoChat))
        assertEquals(shown.copy(failed = true), chatStateAfter(shown, AsbApi.ChatResult.Failed))
        // A failure before any turn shows the failure alone.
        assertEquals(ChatState(failed = true), chatStateAfter(ChatState(), AsbApi.ChatResult.Failed))
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test fun thePollReadsNowAndUntilTheScreenLeaves() = runTest {
        var loads = 0
        val answer = ChatReply(listOf(ChatTurn("user", "", "T", 1, false)), false)
        val job = launch { chatPolls { loads++; AsbApi.ChatResult.Shown(answer) }.collect {} }
        runCurrent()
        assertEquals(1, loads)
        advanceTimeBy(CHAT_POLL_MS + 1)
        runCurrent()
        assertEquals(2, loads)
        job.cancel()
        advanceTimeBy(CHAT_POLL_MS * 3)
        runCurrent()
        assertEquals(2, loads)
    }

    @Test fun theStateWordsAreTheContractWords() {
        assertEquals("Turn on Send message text to phones on the PC to see the chat.", CHAT_OFF)
        assertEquals("This session has no chat to show.", CHAT_NONE)
        assertEquals("Cannot load the chat. Retrying.", CHAT_FAILED)
        assertEquals("Older turns are not shown.", CHAT_OLDER)
    }
}
