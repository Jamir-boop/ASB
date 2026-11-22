package local.asb.companion

import java.net.InetAddress
import kotlinx.coroutines.runBlocking
import local.asb.companion.data.Endpoint
import local.asb.companion.data.PhoneAnswer
import local.asb.companion.net.AnswerReply
import local.asb.companion.net.AsbApi
import local.asb.companion.net.AsbError
import local.asb.companion.net.MemoryPaths
import local.asb.companion.net.ROUTE_NOT_AVAILABLE
import local.asb.companion.net.sha256Hex
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** The answer route: the exact body, and the reply of each status. */
class QuestionAnswerApiTest {
    private lateinit var server: MockWebServer
    private lateinit var fingerprint: String
    private val requestId = "0123456789abcdef0123456789abcdef"

    @Before fun start() {
        val certificate = HeldCertificate.Builder().commonName("ASB answer test").ecdsa256().build()
        fingerprint = sha256Hex(certificate.certificate.encoded)
        server = MockWebServer().apply {
            useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
            start(InetAddress.getByName("127.0.0.1"), 0)
        }
    }

    @After fun stop() = server.shutdown()

    private fun api() = AsbApi(MemoryPaths(listOf(Endpoint("lan", "127.0.0.1"))), server.port, fingerprint, "t".repeat(43))

    private fun reply(code: Int, error: String) = MockResponse().setResponseCode(code).setBody("""{"error":"$error"}""")

    @Test fun theBodyHasOneItemPerQuestionInOrderWithTheLabelsAsReceived() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"answered":true}"""))
        val answers = listOf(
            PhoneAnswer(listOf(" Keep it ")),
            PhoneAnswer(listOf("Tests", "Docs")),
            PhoneAnswer(emptyList(), "Ask \"me\"\nlater"),
            PhoneAnswer(listOf("Lint"), "and the build"),
        )
        assertEquals(AnswerReply.Sent, api().answer("cl/1", requestId, answers, ""))
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/phone/v1/threads/cl%2F1/answer", request.path)
        assertEquals("""{"requestId":"$requestId","answers":[{"selected":[" Keep it "]},{"selected":["Tests","Docs"]},""" +
            """{"selected":[],"other":"Ask \"me\"\nlater"},{"selected":["Lint"],"other":"and the build"}]}""",
            request.body.readUtf8())
    }

    @Test fun eachReplyMapsToItsState() = runBlocking {
        val one = listOf(PhoneAnswer(listOf("Yes")))
        server.enqueue(reply(409, "This question is closed."))
        assertEquals(AnswerReply.Closed, api().answer("one", requestId, one, ""))
        server.enqueue(reply(400, "Invalid answer."))
        assertEquals(AnswerReply.Refused, api().answer("one", requestId, one, ""))
        server.enqueue(reply(404, ROUTE_NOT_AVAILABLE))
        assertEquals(AnswerReply.Off, api().answer("one", requestId, one, ""))
        // Any other 404 is a row that is gone.
        server.enqueue(reply(404, "ASB session not found."))
        assertEquals(AnswerReply.Closed, api().answer("one", requestId, one, ""))
        server.enqueue(reply(500, "Cannot save the answer."))
        try { api().answer("one", requestId, one, ""); fail("Expected an error") }
        catch (cause: AsbError.Server) { assertEquals(500, cause.code); assertEquals("Cannot save the answer.", cause.message) }
    }

    @Test fun aNetworkErrorStaysTheOfflineError() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        try { api().answer("one", requestId, listOf(PhoneAnswer(listOf("Yes"))), ""); fail("Expected an error") }
        catch (cause: AsbError) { assertTrue(cause is AsbError.Offline) }
    }
}
