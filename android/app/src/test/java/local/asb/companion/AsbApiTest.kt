package local.asb.companion

import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Dashboard
import local.asb.companion.data.Endpoint
import local.asb.companion.data.Engine
import local.asb.companion.data.Message
import local.asb.companion.data.PairingInfo
import local.asb.companion.net.AsbApi
import local.asb.companion.net.AsbError
import local.asb.companion.net.DashboardResult
import local.asb.companion.net.MemoryEngines
import local.asb.companion.net.MemoryPaths
import local.asb.companion.net.OLDER_ENGINE
import local.asb.companion.net.offlineMessage
import local.asb.companion.net.sha256Hex
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.TlsVersion
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.Buffer
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
    private lateinit var tls: HandshakeCertificates
    private val token = "t".repeat(43)
    private val deviceId = "012345abcdef"
    private val hello = """{"api":1,"asbVersion":"1.8.1","deviceId":"$deviceId","serverName":"Test PC"}"""

    @Before fun start() {
        val certificate = HeldCertificate.Builder().commonName("ASB test").ecdsa256().build()
        fingerprint = sha256Hex(certificate.certificate.encoded)
        tls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        server = MockWebServer().apply {
            useHttps(tls.sslSocketFactory(), false)
            start(InetAddress.getByName("127.0.0.1"), 0)
        }
    }

    private val peers = mutableListOf<MockWebServer>()

    @After fun stop() {
        server.shutdown()
        peers.forEach { it.shutdown() }
    }

    private fun api(pin: String = fingerprint, onNotPaired: () -> Unit = {}) =
        AsbApi(MemoryPaths(listOf(Endpoint("lan", "127.0.0.1"))), server.port, pin, token, onNotPaired = onNotPaired)

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

    @Test fun gzipDashboardDecodesAndKeepsEtag() = runBlocking {
        val json = """{"generatedAtMs":1780000000000,"threads":[{"id":"one","state":"idle"}]}"""
        val zipped = ByteArrayOutputStream().also { out -> GZIPOutputStream(out).use { it.write(json.toByteArray()) } }
        server.enqueue(MockResponse().setHeader("Content-Encoding", "gzip").setHeader("ETag", "\"zipped\"")
            .setBody(Buffer().write(zipped.toByteArray())))
        val result = api().dashboard() as DashboardResult.Fetched
        assertEquals("\"zipped\"", result.etag)
        assertEquals(1780000000000L, result.dashboard.generatedAtMs)
        assertEquals("one", result.dashboard.threads.single().id)
        assertEquals("gzip", server.takeRequest().getHeader("Accept-Encoding"))
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

    @Test fun dashboardKeepsTheFirstRowOfARepeatedId() = runBlocking {
        server.enqueue(MockResponse().setBody(
            """{"threads":[{"id":"one","state":"working"},{"id":"two"},{"id":"one","state":"unknown"}]}"""))
        val threads = (api().dashboard() as DashboardResult.Fetched).dashboard.threads
        assertEquals(listOf("one", "two"), threads.map { it.id })
        assertEquals("working", threads.first().state)
    }

    @Test fun invalidActionInputIsAnAsbErrorWithoutARequest() = runBlocking {
        for ((id, action, body) in listOf(Triple("", "open", "{}"), Triple(".", "open", "{}"), Triple("..", "open", "{}"),
            Triple("one", "delete", "{}"), Triple("one", "open", "[]"), Triple("one", "open", "not JSON"))) {
            assertTrue(failure { api().action(id, action, body) } is AsbError.Server)
        }
        assertEquals(0, server.requestCount)
    }

    @Test fun pairSendsNoBearerAndValidatesReply() = runBlocking {
        val info = PairingInfo(listOf(Endpoint("lan", "127.0.0.1")), server.port, fingerprint, "c".repeat(27), "Test PC")
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
        val info = PairingInfo(listOf(Endpoint("lan", "127.0.0.1")), server.port, fingerprint, code, "PC")
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
        assertTrue(failure { api().hello() } is AsbError.Offline)
    }

    @Test fun cancellationDoesNotWaitForTheSocketTimeout() = runBlocking {
        server.enqueue(MockResponse().setBody(hello).throttleBody(1, 1, TimeUnit.SECONDS))
        val pending = async { api().hello() }
        assertNotNull(withContext(Dispatchers.IO) { server.takeRequest(5, TimeUnit.SECONDS) })
        delay(100)
        withTimeout(2000) { pending.cancelAndJoin() }
        assertTrue(pending.isCancelled)
    }

    // All endpoints share one port; nothing listens on 127.0.0.2 or 127.0.0.3 unless a test starts a second server there.
    private fun paths(vararg endpoints: Pair<String, String>) = MemoryPaths(endpoints.map { Endpoint(it.first, it.second) })

    private fun api(paths: MemoryPaths) = AsbApi(paths, server.port, fingerprint, token)

    // The same PC on a second address: the same certificate and the same port.
    private fun second(): MockWebServer {
        return MockWebServer().apply {
            useHttps(tls.sslSocketFactory(), false)
            start(InetAddress.getByName("127.0.0.2"), server.port)
        }
    }

    @Test fun getFallsBackToTheNextEndpointAndKeepsIt() = runBlocking {
        val paths = paths("lan" to "127.0.0.2", "zerotier" to "127.0.0.1")
        server.enqueue(MockResponse().setBody(hello))
        assertEquals("Test PC", api(paths).hello().serverName)
        assertEquals(Endpoint("zerotier", "127.0.0.1"), paths.current)
        server.enqueue(MockResponse().setResponseCode(304))
        assertSame(DashboardResult.NotModified, api(paths).dashboard("\"x\""))
        assertEquals(Endpoint("zerotier", "127.0.0.1"), api(paths).endpoint)
        assertEquals(2, server.requestCount)
    }

    @Test fun currentEndpointIsTriedFirstAndAResetStartsAtTheTop() = runBlocking {
        val other = second()
        try {
            val paths = paths("lan" to "127.0.0.2", "zerotier" to "127.0.0.1")
            paths.current = Endpoint("zerotier", "127.0.0.1")
            server.enqueue(MockResponse().setBody(hello))
            api(paths).hello()
            assertEquals(0, other.requestCount)
            paths.current = null
            other.enqueue(MockResponse().setResponseCode(429))
            assertSame(AsbError.Throttled, failure { api(paths).hello() })
            assertEquals(1, other.requestCount)
            assertEquals(1, server.requestCount)
            // An HTTP answer is from the paired PC, so it does not walk on to the next endpoint.
            assertEquals(Endpoint("lan", "127.0.0.2"), paths.current)
        } finally { other.shutdown() }
    }

    @Test fun postIsNotSentAgainToAnotherEndpoint() = runBlocking {
        val other = second()
        try {
            val paths = paths("lan" to "127.0.0.1", "zerotier" to "127.0.0.2")
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            assertTrue(failure { api(paths).action("one", "open") } is AsbError.Offline)
            assertEquals(1, server.requestCount)
            assertEquals(0, other.requestCount)
            val dead = paths("lan" to "127.0.0.3", "zerotier" to "127.0.0.2")
            assertTrue(failure { api(dead).setPersistentUnread(true) } is AsbError.Offline)
            assertEquals(0, other.requestCount)
            assertNull(dead.current)
            other.enqueue(MockResponse().setBody("{}"))
            dead.current = Endpoint("zerotier", "127.0.0.2")
            api(dead).action("one", "open")
            assertEquals("POST", other.takeRequest().method)
        } finally { other.shutdown() }
    }

    private val pairReply = """{"api":1,"deviceId":"$deviceId","token":"$token","serverName":"Test PC","asbVersion":"1.8.1"}"""

    @Test fun pairTriesTheNextEndpointButAnActionTriesOnlyTheFirst() = runBlocking {
        val other = second()
        try {
            // Away from home the LAN address does not answer; ZeroTier does.
            val addresses = listOf(Endpoint("lan", "127.0.0.3"), Endpoint("zerotier", "127.0.0.2"))
            other.enqueue(MockResponse().setBody(pairReply))
            assertEquals(token, AsbApi.pair(PairingInfo(addresses, server.port, fingerprint, "c".repeat(27), "PC"), "Phone").token)
            val request = other.takeRequest()
            assertEquals("/phone/v1/pair", request.path)
            assertNull(request.getHeader("Authorization"))
            // An action with the same addresses still goes to the first one only: the second gets no new request.
            assertTrue(failure { api(MemoryPaths(addresses)).action("one", "open") } is AsbError.Offline)
            assertEquals(1, other.requestCount)
        } finally { other.shutdown() }
    }

    @Test fun pairStopsAtTheFirstReplyAndKeepsTheOfflineAndPinMismatchErrors() = runBlocking {
        val other = second()
        try {
            fun info(pin: String, vararg hosts: String) = PairingInfo(
                hosts.map { Endpoint(if (it == "127.0.0.1") "lan" else "tailscale", it) }, server.port, pin, "c".repeat(27), "PC")
            // A used code gets 403 from the first address; the phone does not ask the next one.
            server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":"This pairing code is not valid."}"""))
            assertEquals("This pairing code is not valid.", failure { AsbApi.pair(info(fingerprint, "127.0.0.1", "127.0.0.2"), "Phone") }.message)
            assertEquals(0, other.requestCount)
            val offline = failure { AsbApi.pair(info(fingerprint, "127.0.0.3", "127.0.0.4"), "Phone") }
            assertTrue(offline is AsbError.Offline)
            assertEquals(offlineMessage(listOf("Tailscale")), offline.message)
            // Every address with another certificate is a pin mismatch.
            val another = sha256Hex(HeldCertificate.Builder().build().certificate.encoded)
            assertSame(AsbError.PinMismatch, failure { AsbApi.pair(info(another, "127.0.0.1", "127.0.0.2"), "Phone") })
            // One address that does not answer makes it Offline again.
            assertTrue(failure { AsbApi.pair(info(another, "127.0.0.1", "127.0.0.3"), "Phone") } is AsbError.Offline)
        } finally { other.shutdown() }
    }

    @Test fun offlineNamesTheOverlayEndpoints() = runBlocking {
        val lanOnly = failure { api(paths("lan" to "127.0.0.2")).hello() }
        assertEquals("Could not reach ASB. Check the PC and Wi-Fi, then try again.", lanOnly.message)
        val away = failure { api(paths("lan" to "127.0.0.2", "tailscale" to "127.0.0.3")).hello() }
        assertEquals("Could not reach ASB. Check the PC and Wi-Fi. Away from home? Turn on Tailscale on this phone.", away.message)
        assertEquals("Could not reach ASB. Check the PC and Wi-Fi. Away from home? Turn on ZeroTier or Tailscale on this phone.",
            offlineMessage(listOf("ZeroTier", "Tailscale")))
        assertTrue(failure { api(MemoryPaths(emptyList())).hello() } is AsbError.Offline)
    }

    @Test fun helloReplacesTheSavedEndpoints() = runBlocking {
        val paths = paths("lan" to "127.0.0.1")
        server.enqueue(MockResponse().setBody(hello))
        api(paths).hello()
        assertEquals(listOf(Endpoint("lan", "127.0.0.1")), paths.endpoints)
        server.enqueue(MockResponse().setBody(hello.dropLast(1) + ""","port":4630,"addresses":[""" +
            """{"kind":"tailscale","address":"100.101.102.103"},{"kind":"vpn","address":"10.0.0.9"},""" +
            """{"kind":"lan","address":"192.168.50.4"},{"kind":"zerotier","address":"10.147.17.4"}]}"""))
        api(paths).hello()
        assertEquals(listOf(Endpoint("lan", "192.168.50.4"), Endpoint("zerotier", "10.147.17.4"),
            Endpoint("tailscale", "100.101.102.103")), paths.endpoints)
        assertNull(paths.current)
    }

    // Another engine of the group: its own server, certificate, port, and pin.
    private class Peer(val server: MockWebServer, val engine: Engine)

    private fun peer(name: String): Peer {
        val certificate = HeldCertificate.Builder().commonName("ASB $name").ecdsa256().build()
        val peerServer = MockWebServer().apply {
            useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
            start(InetAddress.getByName("127.0.0.1"), 0)
        }
        peers += peerServer
        val pin = sha256Hex(certificate.certificate.encoded)
        return Peer(peerServer, Engine(pin.take(16), name, peerServer.port, pin, listOf(Endpoint("lan", "127.0.0.1"))))
    }

    // Nothing listens on 127.0.0.2, so the paired PC is down.
    private val down = MemoryPaths(listOf(Endpoint("lan", "127.0.0.2")))
    private val up get() = MemoryPaths(listOf(Endpoint("lan", "127.0.0.1")))
    private val board = """{"generatedAtMs":1,"threads":[{"id":"one"}]}"""

    private fun api(paths: MemoryPaths, engines: MemoryEngines, pin: String = fingerprint, clock: () -> Long = { 0L },
        onNotPaired: () -> Unit = {}) = AsbApi(paths, server.port, pin, token, engines, clock, onNotPaired)

    @Test fun anotherEngineAnswersWhenThePairedPcIsDownAndBecomesCurrent() = runBlocking {
        val b = peer("workLP")
        val c = peer("homeLP")
        val engines = MemoryEngines(listOf(b.engine, c.engine))
        b.server.enqueue(MockResponse().setBody(board))
        val result = api(down, engines).dashboard() as DashboardResult.Fetched
        assertEquals(b.engine.machineId, result.engine)
        assertEquals(b.engine.machineId, engines.current)
        assertEquals(Endpoint("lan", "127.0.0.1"), engines.endpoint)
        assertEquals(0, c.server.requestCount)
        // The current engine is tried first; then the paired PC; then the others.
        val api = api(down, engines)
        assertEquals(b.engine.machineId, api.engine)
        assertEquals("workLP", api.engineName(b.engine.machineId))
        assertNull(api.engineName(""))
        assertEquals(Endpoint("lan", "127.0.0.1"), api.endpoint)
        b.server.shutdown()
        c.server.enqueue(MockResponse().setBody(board))
        assertEquals(c.engine.machineId, (api.dashboard() as DashboardResult.Fetched).engine)
        assertEquals(c.engine.machineId, engines.current)
    }

    @Test fun onAnotherEngineThePairedPcIsTriedFirstOnceAMinute() = runBlocking {
        val b = peer("workLP")
        val engines = MemoryEngines(listOf(b.engine), b.engine.machineId, b.engine.addresses.single())
        var now = 0L
        val paths = up
        val api = api(paths, engines, clock = { now })
        // A new object counts as never tried: the paired PC first.
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        b.server.enqueue(MockResponse().setBody(board))
        assertEquals(b.engine.machineId, (api.dashboard() as DashboardResult.Fetched).engine)
        assertEquals(listOf(1, 1), listOf(server.requestCount, b.server.requestCount))
        now = 59_999
        b.server.enqueue(MockResponse().setBody(board))
        assertEquals(b.engine.machineId, (api.dashboard() as DashboardResult.Fetched).engine)
        assertEquals(listOf(1, 2), listOf(server.requestCount, b.server.requestCount))
        now = 60_000
        server.enqueue(MockResponse().setBody(board))
        assertEquals("", (api.dashboard() as DashboardResult.Fetched).engine)
        assertEquals(listOf(2, 2), listOf(server.requestCount, b.server.requestCount))
        assertEquals(listOf("", null), listOf(engines.current, engines.endpoint))
        assertEquals(Endpoint("lan", "127.0.0.1"), paths.current)
        // Another new object on the other engine goes to the paired PC first again.
        engines.current = b.engine.machineId
        server.enqueue(MockResponse().setBody(board))
        assertEquals("", (api(up, engines).dashboard() as DashboardResult.Fetched).engine)
        assertEquals(2, b.server.requestCount)
    }

    @Test fun eachEngineHasItsOwnPin() = runBlocking {
        val b = peer("workLP")
        val c = peer("homeLP")
        // B with the pin of the paired PC fails for B only.
        val engines = MemoryEngines(listOf(b.engine.copy(fingerprint = fingerprint), c.engine))
        c.server.enqueue(MockResponse().setBody(board))
        assertEquals(c.engine.machineId, (api(down, engines).dashboard() as DashboardResult.Fetched).engine)
        assertEquals(0, b.server.requestCount)
        // Every endpoint of every engine with a pin mismatch.
        val other = sha256Hex(HeldCertificate.Builder().build().certificate.encoded)
        val wrong = MemoryEngines(listOf(b.engine.copy(fingerprint = other)))
        assertSame(AsbError.PinMismatch, failure { api(up, wrong, pin = other).dashboard() })
        // A down PC and a mismatch are Offline.
        assertTrue(failure { api(down, wrong).dashboard() } is AsbError.Offline)
    }

    @Test fun unauthorizedFromAnotherEngineIsNotAnAnswerButFromThePairedPcRevokes() = runBlocking {
        val b = peer("workLP")
        val c = peer("homeLP")
        var revoked = false
        b.server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        c.server.enqueue(MockResponse().setBody(board))
        val engines = MemoryEngines(listOf(b.engine, c.engine))
        assertEquals(c.engine.machineId, (api(down, engines) { revoked = true }.dashboard() as DashboardResult.Fetched).engine)
        assertFalse(revoked)
        b.server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        val alone = MemoryEngines(listOf(b.engine))
        assertTrue(failure { api(down, alone) { revoked = true }.dashboard() } is AsbError.Offline)
        assertFalse(revoked)
        assertEquals("", alone.current)
        server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        assertSame(AsbError.NotPaired, failure { api(up, MemoryEngines(listOf(c.engine))) { revoked = true }.dashboard() })
        assertTrue(revoked)
    }

    @Test fun aPostGoesOnlyToTheNamedEngineAndOnlyOnce() = runBlocking {
        val b = peer("workLP")
        val engines = MemoryEngines(listOf(b.engine))
        b.server.enqueue(MockResponse().setBody("{}"))
        api(up, engines).action("m:x:one", "mark-read", engine = b.engine.machineId)
        assertEquals("/phone/v1/threads/m:x:one/mark-read", b.server.takeRequest().path)
        assertEquals(0, server.requestCount)
        // The paired PC is down: no request to another engine.
        assertTrue(failure { api(down, engines).action("one", "open") } is AsbError.Offline)
        assertTrue(failure { api(down, engines).setPersistentUnread(true) } is AsbError.Offline)
        b.server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        assertTrue(failure { api(up, engines).setPersistentUnread(true, b.engine.machineId) } is AsbError.Offline)
        assertTrue(failure { api(up, engines).action("one", "open", engine = "cccccccccccccccc") } is AsbError.Offline)
        assertEquals(listOf(0, 2), listOf(server.requestCount, b.server.requestCount))
        assertEquals("", engines.current)
    }

    @Test fun theEtagGoesOnlyToItsEngine() = runBlocking {
        val b = peer("workLP")
        val engines = MemoryEngines(listOf(b.engine))
        b.server.enqueue(MockResponse().setHeader("ETag", "b1").setBody(board))
        val fetched = api(down, engines).dashboard("\"a1\"", etagEngine = "") as DashboardResult.Fetched
        assertEquals(listOf("b1", b.engine.machineId), listOf(fetched.etag, fetched.engine))
        assertNull(b.server.takeRequest().getHeader("If-None-Match"))
        b.server.enqueue(MockResponse().setResponseCode(304))
        assertSame(DashboardResult.NotModified, api(down, engines).dashboard("b1", etagEngine = b.engine.machineId))
        assertEquals("b1", b.server.takeRequest().getHeader("If-None-Match"))
    }

    private fun helloWith(vararg engines: Engine, addresses: String = "") = hello.dropLast(1) +
        ""","machineId":"0123456789abcdef","addresses":[$addresses],"engines":${AsbJson.encodeToString(engines.toList())}}"""

    @Test fun helloFromAnotherEngineListsTheEnginesButKeepsTheAddressesOfThePairing() = runBlocking {
        val b = peer("workLP")
        val c = peer("homeLP")
        val paired = Engine("0123456789abcdef", "debian", server.port, fingerprint, listOf(Endpoint("lan", "127.0.0.1")))
        val engines = MemoryEngines(listOf(b.engine))
        b.server.enqueue(MockResponse().setBody(helloWith(paired, b.engine, c.engine, c.engine.copy(name = "bad name"),
            addresses = """{"kind":"lan","address":"192.168.9.9"}""")))
        val paths = down
        api(paths, engines).hello()
        assertEquals(listOf(Endpoint("lan", "127.0.0.2")), paths.endpoints)
        assertEquals(listOf(b.engine, c.engine), engines.list)
        assertEquals(b.engine.machineId, engines.current)
        // An engine that no longer lists itself (it left the group) ends its use.
        b.server.enqueue(MockResponse().setBody(helloWith()))
        api(paths, engines).hello()
        assertEquals(listOf(emptyList<Engine>(), ""), listOf(engines.list, engines.current))
        // The paired PC gives the addresses of the pairing.
        server.enqueue(MockResponse().setBody(helloWith(paired, c.engine,
            addresses = """{"kind":"lan","address":"127.0.0.1"},{"kind":"zerotier","address":"127.0.0.3"}""")))
        val pairing = up
        api(pairing, engines).hello()
        assertEquals(listOf(Endpoint("lan", "127.0.0.1"), Endpoint("zerotier", "127.0.0.3")), pairing.endpoints)
        assertEquals(listOf(c.engine), engines.list)
    }

    @Test fun aProbeAsksOneEngineAndChangesNothing() = runBlocking {
        val b = peer("workLP")
        val c = peer("homeLP")
        var revoked = false
        val engines = MemoryEngines(listOf(b.engine, c.engine))
        val paths = up
        val api = api(paths, engines) { revoked = true }
        b.server.enqueue(MockResponse().setBody(hello))
        assertTrue(api.probe(b.engine.machineId))
        assertEquals(listOf("", null, null), listOf(engines.current, engines.endpoint, paths.current))
        assertEquals(0, server.requestCount + c.server.requestCount)
        c.server.enqueue(MockResponse().setBody("not JSON"))
        assertFalse(api.probe(c.engine.machineId))
        server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        assertFalse(api.probe(""))
        assertFalse(revoked)
        assertFalse(api.probe("cccccccccccccccc"))
        assertFalse(api(down, engines).probe(""))
        server.enqueue(MockResponse().setBody(hello))
        assertTrue(api.probe(""))
        assertEquals(listOf(null, listOf(b.engine, c.engine)), listOf(paths.current, engines.list))
    }

    @Test fun activityCallsSendOnlyThePeriodWithTheBearerToTheGivenEngine() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"period":"7d","nowMs":1793000000000,"messages":[""" +
            """{"id":"00000000-0000-4000-8000-000000000001","from":"a","to":"b","atMs":1793000000000,"status":"accepted"}]}"""))
        val messages = api().activityMessages("7d", "")
        assertEquals("a", messages.messages.single().from)
        val first = server.takeRequest()
        assertEquals("/phone/v1/activity/messages?period=7d", first.path)
        assertEquals("Bearer $token", first.getHeader("Authorization"))
        server.enqueue(MockResponse().setBody("""{"period":"30d","scan":{"complete":false,"files":2,"scannedFiles":1}}"""))
        assertFalse(api().activityUsage("30d", "").scan.complete)
        val second = server.takeRequest()
        assertEquals("/phone/v1/activity/usage?period=30d", second.path)
        assertEquals("Bearer $token", second.getHeader("Authorization"))
        // The engine of the dashboard on screen gets the request, and no other.
        val b = peer("member")
        b.server.enqueue(MockResponse().setBody("{}"))
        api(up, MemoryEngines(listOf(b.engine))).activityUsage("90d", b.engine.machineId)
        assertEquals("/phone/v1/activity/usage?period=90d", b.server.takeRequest().path)
        assertEquals(2, server.requestCount)
    }

    @Test fun activityUsageAcceptsMakersAndOlderRecordsWithExtraFields() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"future":true,"records":[
            {"app":"pi","model":"model-a","maker":"Anthropic","tokens":{"output":10},"future":1},
            {"app":"grok","model":"model-b","tokens":{"output":20}},
            {"app":"antigravity","model":"model-c","maker":""}]}"""))
        val usage = api().activityUsage("30d", "")
        assertEquals(listOf("Anthropic", "", ""), usage.records.map { it.maker })
        assertEquals(listOf("pi", "grok", "antigravity"), usage.records.map { it.app })
        assertEquals(listOf(10L, 20L, 0L), usage.records.map { it.tokens.processed })
        assertEquals("/phone/v1/activity/usage?period=30d", server.takeRequest().path)
    }

    @Test fun usageAcceptsAllTimeWithMonthlyBuckets() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"period":"all","buckets":{"unit":"month","startsMs":[1790812800000]}}"""))
        val reply = api().activityUsage("all", "")
        assertEquals("all", reply.period)
        assertEquals("month", reply.buckets.unit)
        assertEquals(listOf(1790812800000L), reply.buckets.startsMs)
        assertEquals("/phone/v1/activity/usage?period=all", server.takeRequest().path)
    }

    @Test fun anOlderGatewayWithoutAllTimeAsksForAnUpdate() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"Invalid period."}"""))
        assertEquals("This PC runs an older ASB. Update ASB on the PC to see All time.", failure { api().activityUsage("all", "") }.message)
        // After the default All time fails, the user can select a period that the PC knows.
        server.enqueue(MockResponse().setBody("""{"period":"30d"}"""))
        assertEquals("30d", api().activityUsage("30d", "").period)
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"Invalid period."}"""))
        assertEquals("Invalid period.", failure { api().activityUsage("30d", "") }.message)
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"No access"}"""))
        assertEquals("No access", failure { api().activityUsage("all", "") }.message)
    }

    @Test fun anInvalidPeriodThrowsBeforeAnyRequest() = runBlocking {
        for (call in listOf<suspend () -> Unit>({ api().activityMessages("90d", "") }, { api().activityMessages("", "") },
            { api().activityMessages("all", "") },
            { api().activityUsage("1d", "") }, { api().activityUsage("30d&force=1", "") })) {
            assertEquals("Invalid period.", failure(call).message)
        }
        assertEquals(0, server.requestCount)
    }

    @Test fun anOlderEngineWithoutTheRoutesAsksForAnUpdate() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"Not found."}"""))
        assertEquals(OLDER_ENGINE, failure { api().activityMessages("24h", "") }.message)
        assertEquals("This PC runs an older ASB. Update ASB on the PC to see messages and usage.", OLDER_ENGINE)
        server.enqueue(MockResponse().setResponseCode(404).setBody("{}"))
        assertEquals(OLDER_ENGINE, failure { api().activityUsage("7d", "") }.message)
        // Other routes keep the server text for a 404.
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"Not found."}"""))
        assertEquals("Not found.", failure { api().action("one", "open") }.message)
    }
}
