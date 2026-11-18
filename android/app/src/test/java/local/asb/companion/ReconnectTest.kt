package local.asb.companion

import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.TimeUnit
import javax.net.ServerSocketFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import local.asb.companion.data.Endpoint
import local.asb.companion.net.AsbApi
import local.asb.companion.net.AsbError
import local.asb.companion.net.DashboardResult
import local.asb.companion.net.MemoryPaths
import local.asb.companion.net.pinnedConnections
import local.asb.companion.net.sha256Hex
import okhttp3.Protocol
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

/** The gateway closes its listener and its sockets and listens again on the same port (a settings change, a server restart). */
class ReconnectTest {
    private lateinit var server: MockWebServer
    private lateinit var fingerprint: String
    private lateinit var tls: HandshakeCertificates
    private val board = """{"generatedAtMs":1780000000000,"threads":[{"id":"one","state":"idle"}]}"""

    @Before fun start() {
        pinnedConnections.evictAll()
        val certificate = HeldCertificate.Builder().commonName("ASB test").ecdsa256().build()
        fingerprint = sha256Hex(certificate.certificate.encoded)
        tls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        server = listen(0)
    }

    @After fun stop() { server.shutdown() }

    private fun listen(port: Int) = MockWebServer().apply {
        useHttps(tls.sslSocketFactory(), false)
        // The gateway is a Node https server: HTTP/1.1, one request per socket at a time.
        protocols = listOf(Protocol.HTTP_1_1)
        // As Node does (SO_REUSEADDR), so the same port binds again while the closed sockets wait for the phone.
        serverSocketFactory = object : ServerSocketFactory() {
            override fun createServerSocket() = object : ServerSocket() {
                init { super.setReuseAddress(true) }
                override fun setReuseAddress(on: Boolean) {}
            }
            override fun createServerSocket(port: Int) = throw UnsupportedOperationException()
            override fun createServerSocket(port: Int, backlog: Int) = throw UnsupportedOperationException()
            override fun createServerSocket(port: Int, backlog: Int, address: InetAddress?) = throw UnsupportedOperationException()
        }
        start(InetAddress.getByName("127.0.0.1"), port)
    }

    private fun restart() {
        val port = server.port
        server.shutdown()
        server = listen(port)
    }

    private fun api() = AsbApi(MemoryPaths(listOf(Endpoint("lan", "127.0.0.1"))), server.port, fingerprint, "t".repeat(43))

    // Three requests at the same time leave three idle sockets in the pool, as the screen client does.
    private suspend fun fillPool(api: AsbApi) {
        repeat(3) { server.enqueue(MockResponse().setBody(board).setBodyDelay(300, TimeUnit.MILLISECONDS)) }
        coroutineScope { (1..3).map { async(Dispatchers.IO) { api.dashboard() } }.awaitAll() }
        assertEquals(3, pinnedConnections.idleConnectionCount())
    }

    @Test fun theNextGetAfterARestartSucceedsAndLaterGetsToo() = runBlocking {
        val api = api()
        fillPool(api)
        restart()
        val restartedAtMs = System.currentTimeMillis()
        repeat(3) { server.enqueue(MockResponse().setBody(board)) }
        repeat(3) { index ->
            try {
                assertTrue(api.dashboard() is DashboardResult.Fetched)
            } catch (error: AsbError) {
                fail("GET ${index + 1} after the restart failed: $error")
            }
        }
        assertTrue(System.currentTimeMillis() - restartedAtMs < 3500)
        assertEquals(3, server.requestCount)
    }

    @Test fun aPostOnAStaleConnectionIsNotSentTwiceAndTheNextGetSucceeds() = runBlocking {
        val api = api()
        server.enqueue(MockResponse().setBody(board))
        api.dashboard()
        // The PC gets the POST and closes the socket before its reply: the POST fails and is not sent again.
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        server.enqueue(MockResponse().setBody("{}"))
        try { api.action("one", "open"); fail("Expected an ASB error") } catch (error: AsbError) {
            assertTrue(error is AsbError.Offline)
        }
        assertEquals(2, server.requestCount)
        // A POST on a socket of the stopped listener does not reach the new listener at all, and is not sent again.
        server.enqueue(MockResponse().setBody(board))
        api.dashboard()
        restart()
        server.enqueue(MockResponse().setBody("{}"))
        try { api.action("one", "open") } catch (_: AsbError.Offline) {}
        assertTrue(server.requestCount <= 1)
        val posts = server.requestCount
        server.enqueue(MockResponse().setBody(board))
        assertTrue(api.dashboard() is DashboardResult.Fetched)
        assertEquals(posts + 1, server.requestCount)
    }
}
