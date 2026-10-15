package local.asb.companion

import java.net.InetAddress
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Dashboard
import local.asb.companion.data.Message
import local.asb.companion.data.PairingInfo
import local.asb.companion.net.AsbApi
import local.asb.companion.net.AsbError
import local.asb.companion.net.DashboardResult
import local.asb.companion.net.sha256Hex
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.TlsVersion
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class AsbApiTest {
    private lateinit var server: MockWebServer
    private lateinit var fingerprint: String
    private val token = "t".repeat(43)
    private val deviceId = "012345abcdef"
    private val hello = """{"api":1,"asbVersion":"1.8.1","deviceId":"$deviceId","serverName":"Test PC"}"""

    @Before fun start() {
        val certificate = HeldCertificate.Builder().commonName("ASB test").ecdsa256().build()
        fingerprint = sha256Hex(certificate.certificate.encoded)
        val tls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        server = MockWebServer().apply {
            useHttps(tls.sslSocketFactory(), false)
            start(InetAddress.getByName("127.0.0.1"), 0)
        }
    }

    @After fun stop() { server.shutdown() }

    private fun api(pin: String = fingerprint, onNotPaired: () -> Unit = {}) =
        AsbApi("127.0.0.1", server.port, pin, token, onNotPaired)

    private suspend fun failure(block: suspend () -> Unit): AsbError {
        try { block() } catch (error: AsbError) { return error }
        fail("Expected an ASB error")
        throw AssertionError()
    }

    @Test fun matchingPinUsesTls13AndBearer() = runBlocking {
        server.enqueue(MockResponse().setBody(hello))
        assertEquals("Test PC", api().hello().serverName)
        val request = server.takeRequest()
        assertEquals("/phone/v1/hello", request.path)
        assertEquals("Bearer $token", request.getHeader("Authorization"))
        assertEquals(TlsVersion.TLS_1_3, request.handshake!!.tlsVersion)
    }

    @Test fun anotherCertificateIsPinMismatch() = runBlocking {
        val another = HeldCertificate.Builder().build()
        assertSame(AsbError.PinMismatch, failure { api(sha256Hex(another.certificate.encoded)).hello() })
    }

    @Test fun unauthorizedRevokesButParseFailureDoesNot() = runBlocking {
        var revoked = false
        val api = api { revoked = true }
        server.enqueue(MockResponse().setResponseCode(200).setBody("not JSON"))
        assertTrue(failure { api.hello() } is AsbError.Server)
        assertFalse(revoked)
        server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        assertSame(AsbError.NotPaired, failure { api.hello() })
        assertTrue(revoked)
    }

    @Test fun notModifiedKeepsEtagAndForceQuery() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(304))
        assertSame(DashboardResult.NotModified, api().dashboard("\"snapshot\"", true))
        val request = server.takeRequest()
        assertEquals("/phone/v1/dashboard?force=1", request.path)
        assertEquals("\"snapshot\"", request.getHeader("If-None-Match"))
    }

    @Test fun dashboardDefaultsIgnoreNewFieldsAndKeepLongTimes() = runBlocking {
        server.enqueue(MockResponse().setHeader("ETag", "next").setBody(
            """{"generatedAtMs":1780000000000,"future":true,"threads":[{"id":"one","sourceCount":2,"updatedAtMs":1780000000001,"future":[]}]}"""))
        val result = api().dashboard() as DashboardResult.Fetched
        assertEquals("next", result.etag)
        assertEquals(1780000000000L, result.dashboard.generatedAtMs)
        assertEquals(1780000000001L, result.dashboard.threads.single().updatedAtMs)
        assertEquals("unknown", result.dashboard.threads.single().state)
        assertTrue(result.dashboard.threads.single().sourceShowMarker)
        assertEquals(Dashboard(), AsbJson.decodeFromString<Dashboard>("{}"))
    }

    @Test fun fractionalDashboardTimesDecode() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"generatedAtMs":1792106050999.9,"threads":[""" +
            """{"id":"one","updatedAtMs":1792106050744.051,"limitResetsAtMs":1792109650000.5},""" +
            """{"id":"two","updatedAtMs":1792106050744}],"messages":[{"from":"one","to":"two","atMs":1792106050500.5}]}"""))
        val board = (api().dashboard() as DashboardResult.Fetched).dashboard
        assertEquals(1792106050999L, board.generatedAtMs)
        assertEquals(listOf(1792106050744L, 1792106050744L), board.threads.map { it.updatedAtMs })
        assertEquals(1792109650000L, board.threads.first().limitResetsAtMs)
        assertEquals(1792106050500L, board.messages.single().atMs)
    }

    @Test fun invalidActionInputIsAnAsbErrorWithoutARequest() = runBlocking {
        for ((id, action, body) in listOf(Triple("", "open", "{}"), Triple(".", "open", "{}"), Triple("..", "open", "{}"),
            Triple("one", "delete", "{}"), Triple("one", "open", "[]"), Triple("one", "open", "not JSON"))) {
            assertTrue(failure { api().action(id, action, body) } is AsbError.Server)
        }
        assertEquals(0, server.requestCount)
    }

    @Test fun pairSendsNoBearerAndValidatesReply() = runBlocking {
        val info = PairingInfo("127.0.0.1", server.port, fingerprint, "c".repeat(27), "Test PC")
        server.enqueue(MockResponse().setBody(
            """{"api":1,"deviceId":"$deviceId","token":"$token","serverName":"Test PC","asbVersion":"1.8.1"}"""))
        assertEquals(token, AsbApi.pair(info, "My \"phone\"").token)
        val request = server.takeRequest()
        assertNull(request.getHeader("Authorization"))
        assertEquals("/phone/v1/pair", request.path)
        val body = AsbJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(info.code, body.getValue("code").jsonPrimitive.content)
        assertEquals("My \"phone\"", body.getValue("deviceName").jsonPrimitive.content)
        server.enqueue(MockResponse().setBody("{}"))
        assertTrue(failure { AsbApi.pair(info, "Phone") } is AsbError.Server)
    }

    @Test fun malformedMessageEntriesDoNotFailTheDashboardRequest() = runBlocking {
        server.enqueue(MockResponse().setBody("""{
            "threads":[{"id":"one","limitResetsAtMs":1780000000000}],
            "messages":[null,42,{"from":"a","to":"b","atMs":"1"},
                {"from":"a","to":"b","atMs":1e100000},{"from":"a","to":"b","atMs":1.5}]
        }"""))
        val result = api().dashboard() as DashboardResult.Fetched
        assertEquals("one", result.dashboard.threads.single().id)
        assertEquals(1780000000000L, result.dashboard.threads.single().limitResetsAtMs)
        assertEquals(listOf(Message("a", "b", 1)), result.dashboard.messages)
    }

    @Test fun serverErrorsPreserveMessagesButRemoveSecrets() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"No access","detail":"Try again $token"}"""))
        val error = failure { api().hello() }
        assertEquals("No access Try again [removed]", error.message)
        val code = "p".repeat(27)
        val info = PairingInfo("127.0.0.1", server.port, fingerprint, code, "PC")
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":"Bad code $code"}"""))
        assertFalse(failure { AsbApi.pair(info, "Phone") }.message!!.contains(code))
    }

    @Test fun actionsEncodeOnlyOnePathSegment() = runBlocking {
        server.enqueue(MockResponse().setBody("{}"))
        api().action("profile:chat/a?b#c%2F", "open")
        val request = server.takeRequest()
        assertEquals("/phone/v1/threads/profile:chat%2Fa%3Fb%23c%252F/open", request.path)
        assertEquals("POST", request.method)
        assertEquals("Bearer $token", request.getHeader("Authorization"))
        server.enqueue(MockResponse().setBody("{}"))
        api().setPersistentUnread(false)
        val setting = server.takeRequest()
        assertEquals("/phone/v1/settings/unread", setting.path)
        assertEquals("false", AsbJson.parseToJsonElement(setting.body.readUtf8()).jsonObject
            .getValue("persistentUnread").jsonPrimitive.content)
    }

    @Test fun throttleOfflineAndRedirectAreSeparateErrors() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(429))
        assertSame(AsbError.Throttled, failure { api().hello() })
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", server.url("/other")))
        assertTrue(failure { api().hello() } is AsbError.Server)
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        assertSame(AsbError.Offline, failure { api().hello() })
    }

    @Test fun cancellationDoesNotWaitForTheSocketTimeout() = runBlocking {
        server.enqueue(MockResponse().setBody(hello).throttleBody(1, 1, TimeUnit.SECONDS))
        val pending = async { api().hello() }
        assertNotNull(withContext(Dispatchers.IO) { server.takeRequest(5, TimeUnit.SECONDS) })
        delay(100)
        withTimeout(2000) { pending.cancelAndJoin() }
        assertTrue(pending.isCancelled)
    }
}
