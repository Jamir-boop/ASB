package local.asb.companion

import java.net.InetAddress
import kotlinx.coroutines.runBlocking
import local.asb.companion.data.Endpoint
import local.asb.companion.net.AnswerReply
import local.asb.companion.net.AsbApi
import local.asb.companion.net.AsbError
import local.asb.companion.net.Decision
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

/** The decision body on the answer route, and the reply of each status. */
class ApprovalApiTest {
    private lateinit var server: MockWebServer
    private lateinit var fingerprint: String
    private val requestId = "0123456789abcdef0123456789abcdef"

    @Before fun start() {
        val certificate = HeldCertificate.Builder().commonName("ASB approval test").ecdsa256().build()
        fingerprint = sha256Hex(certificate.certificate.encoded)
        server = MockWebServer().apply {
            useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
            start(InetAddress.getByName("127.0.0.1"), 0)
        }
    }

    @After fun stop() = server.shutdown()

    private fun api() = AsbApi(MemoryPaths(listOf(Endpoint("lan", "127.0.0.1"))), server.port, fingerprint, "t".repeat(43))

    private fun reply(code: Int, error: String) = MockResponse().setResponseCode(code).setBody("""{"error":"$error"}""")

    private fun body(decision: Decision, note: String?): String {
        server.enqueue(MockResponse().setBody("""{"answered":true}"""))
        assertEquals(AnswerReply.Sent, runBlocking { api().decide("cl/1", requestId, decision, note, "") })
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/phone/v1/threads/cl%2F1/answer", request.path)
        return request.body.readUtf8()
    }

    @Test fun theBodyHasExactlyTheRequestTheDecisionAndADenyNote() {
        assertEquals("""{"requestId":"$requestId","decision":"allow"}""", body(Decision.Allow, null))
        assertEquals("""{"requestId":"$requestId","decision":"deny"}""", body(Decision.Deny, null))
        assertEquals("""{"requestId":"$requestId","decision":"deny","note":"Use \"make\"\nfirst"}""",
            body(Decision.Deny, "Use \"make\"\nfirst"))
        // A note never goes with an allow, and a blank note is no note.
        assertEquals("""{"requestId":"$requestId","decision":"allow"}""", body(Decision.Allow, "Not sent"))
        assertEquals("""{"requestId":"$requestId","decision":"deny"}""", body(Decision.Deny, " \n\t"))
    }

    @Test fun eachReplyMapsToItsStateAsForAnswers() = runBlocking {
        server.enqueue(reply(409, "This request is closed."))
        assertEquals(AnswerReply.Closed, api().decide("one", requestId, Decision.Allow, null, ""))
        server.enqueue(reply(400, "Invalid decision."))
        assertEquals(AnswerReply.Refused, api().decide("one", requestId, Decision.Deny, null, ""))
        server.enqueue(reply(404, ROUTE_NOT_AVAILABLE))
        assertEquals(AnswerReply.Off, api().decide("one", requestId, Decision.Allow, null, ""))
        server.enqueue(reply(404, "ASB session not found."))
        assertEquals(AnswerReply.Closed, api().decide("one", requestId, Decision.Allow, null, ""))
        server.enqueue(reply(500, "Made-up failure."))
        try { api().decide("one", requestId, Decision.Allow, null, ""); fail("Expected an error") }
        catch (cause: AsbError.Server) { assertEquals(500, cause.code) }
        try { api().decide("..", requestId, Decision.Allow, null, ""); fail("Expected an error") }
        catch (cause: AsbError.Server) { assertEquals("Invalid session ID.", cause.message) }
    }

    @Test fun aNetworkErrorStaysTheOfflineError() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        try { api().decide("one", requestId, Decision.Allow, null, ""); fail("Expected an error") }
        catch (cause: AsbError) { assertTrue(cause is AsbError.Offline) }
    }
}
