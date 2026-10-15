package local.asb.companion

import androidx.lifecycle.ViewModelStore
import java.net.InetAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.encodeToString
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Dashboard
import local.asb.companion.data.Thread
import local.asb.companion.net.AsbApi
import local.asb.companion.net.AsbError
import local.asb.companion.net.sha256Hex
import local.asb.companion.ui.Filter
import local.asb.companion.ui.SessionsViewModel
import okhttp3.Protocol
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SessionsViewModelTest {
    private val scheduler = TestCoroutineScheduler()
    private val dispatcher = StandardTestDispatcher(scheduler)
    private val models = ViewModelStore()
    private val polls = mutableListOf<Job>()
    private val baselines = mutableListOf<Map<String, Int>>()
    private lateinit var server: MockWebServer
    private lateinit var fingerprint: String
    private lateinit var certificates: HandshakeCertificates
    private var revoked = false

    @Before fun start() {
        Dispatchers.setMain(dispatcher)
        val certificate = HeldCertificate.Builder().commonName("ASB sessions test").ecdsa256().build()
        fingerprint = sha256Hex(certificate.certificate.encoded)
        certificates = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        server = MockWebServer().apply {
            useHttps(certificates.sslSocketFactory(), false)
            start(InetAddress.getByName("127.0.0.1"), 0)
        }
    }

    @After fun stop() {
        polls.forEach { it.cancel() }
        models.clear()
        scheduler.runCurrent()
        server.shutdown()
        Dispatchers.resetMain()
    }

    private fun model(mutex: Mutex = Mutex(), initiallyRevoked: Boolean = false): SessionsViewModel {
        val api = AsbApi("127.0.0.1", server.port, fingerprint, "t".repeat(43)) { revoked = true }
        return SessionsViewModel(api, "Test PC", initiallyRevoked, { baselines += it }, mutex)
            .also { models.put("sessions", it) }
    }

    private fun poll(model: SessionsViewModel): Job = CoroutineScope(dispatcher).launch { model.poll() }
        .also { polls += it }

    private fun response(dashboard: Dashboard, etag: String = "snapshot") = MockResponse()
        .setHeader("ETag", etag).setBody(AsbJson.encodeToString(dashboard))

    private suspend fun await(condition: () -> Boolean) = withTimeout(5000) {
        while (true) {
            scheduler.runCurrent()
            if (condition()) break
            delay(5)
        }
    }

    private fun advance(ms: Long) { scheduler.advanceTimeBy(ms); scheduler.runCurrent() }

    private suspend fun load(model: SessionsViewModel, dashboard: Dashboard) {
        server.enqueue(response(dashboard))
        model.refresh()
        await { !model.state.value.refreshing }
        assertEquals(dashboard, model.state.value.dashboard)
        server.takeRequest()
    }

    @Test fun pollingRetainsEtagAndDashboardOn304AndUsesOnlyApprovedIntervals() = runBlocking {
        val working = Dashboard(1, refreshIntervalMs = 2000,
            threads = listOf(Thread(id = "one", state = "working", completionAttention = true)))
        val idle = working.copy(generatedAtMs = 2, refreshIntervalMs = 123)
        server.enqueue(response(working, "one"))
        server.enqueue(MockResponse().setResponseCode(304))
        server.enqueue(response(idle, "two"))
        server.enqueue(MockResponse().setResponseCode(304))
        val model = model()
        val first = poll(model)
        await { baselines.size == 1 }
        assertNull(server.takeRequest().getHeader("If-None-Match"))
        assertEquals(mapOf("one" to 1), baselines.single())
        val dashboard = model.state.value.dashboard
        val duplicate = poll(model)
        scheduler.runCurrent()
        assertTrue(duplicate.isCompleted)

        advance(1999)
        assertEquals(1, server.requestCount)
        advance(1)
        await { baselines.size == 2 }
        assertEquals("one", server.takeRequest().getHeader("If-None-Match"))
        assertSame(dashboard, model.state.value.dashboard)
        advance(2000)
        await { model.state.value.dashboard?.generatedAtMs == 2L }
        assertEquals("one", server.takeRequest().getHeader("If-None-Match"))
        advance(4999)
        assertEquals(3, server.requestCount)
        advance(1)
        await { baselines.size == 4 }
        assertEquals("two", server.takeRequest().getHeader("If-None-Match"))
        first.cancel()
        scheduler.runCurrent()
        advance(60000)
        assertEquals(4, server.requestCount)
    }

    @Test fun offlineBackoffKeepsCachedDataCapsAt30SecondsAndResetsOnSuccess() = runBlocking {
        val dashboard = Dashboard(1, threads = listOf(Thread(id = "cached")))
        server.enqueue(response(dashboard))
        repeat(4) { server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)) }
        server.enqueue(response(dashboard.copy(generatedAtMs = 2)))
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        server.enqueue(response(dashboard.copy(generatedAtMs = 3)))
        val model = model()
        poll(model)
        await { model.state.value.dashboard != null }
        server.takeRequest()

        for ((index, waitMs) in listOf(5000L, 5000L, 10000L, 30000L).withIndex()) {
            model.clearError()
            advance(waitMs - 1)
            assertEquals(index + 1, server.requestCount)
            advance(1)
            await { model.state.value.lastError != null }
            assertTrue(model.state.value.offline)
            assertEquals(dashboard, model.state.value.dashboard)
            server.takeRequest()
        }
        advance(29999)
        assertEquals(5, server.requestCount)
        advance(1)
        await { model.state.value.dashboard?.generatedAtMs == 2L }
        assertFalse(model.state.value.offline)
        server.takeRequest()
        advance(5000)
        await { model.state.value.offline }
        server.takeRequest()
        advance(4999)
        assertEquals(7, server.requestCount)
        advance(1)
        await { model.state.value.dashboard?.generatedAtMs == 3L }
        assertFalse(model.state.value.offline)
    }

    @Test fun forcedRefreshAndPollingShareTheWholeFetchAndBaselineLock() = runBlocking {
        val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path!!.contains("force=1")) {
                    assertTrue(release.await(5, TimeUnit.SECONDS))
                    return response(Dashboard(1), "old")
                }
                return response(Dashboard(2), "new")
            }
        }
        val mutex = Mutex(locked = true)
        val model = model(mutex)
        model.refresh()
        model.refresh()
        poll(model)
        scheduler.runCurrent()
        assertTrue(model.state.value.refreshing)
        assertEquals(0, server.requestCount)
        mutex.unlock()
        await { server.requestCount == 1 }
        val forced = server.takeRequest()
        assertEquals("/phone/v1/dashboard?force=1", forced.path)
        assertNull(forced.getHeader("If-None-Match"))
        assertTrue(baselines.isEmpty())
        assertEquals(1, server.requestCount)
        release.countDown()
        await { model.state.value.dashboard?.generatedAtMs == 2L }
        assertFalse(model.state.value.refreshing)
        assertEquals("old", server.takeRequest().getHeader("If-None-Match"))
        assertEquals(2, baselines.size)
    }

    @Test fun serverDashboardFailureKeepsCachedRowsOfflineUntil304AndRetriesAfter5Seconds() = runBlocking {
        val dashboard = Dashboard(1, refreshIntervalMs = 2000, threads = listOf(Thread(id = "cached")))
        server.enqueue(response(dashboard, "cached"))
        server.enqueue(MockResponse().setResponseCode(500).setBody("{\"error\":\"Refresh failed\"}"))
        server.enqueue(MockResponse().setResponseCode(304))
        val model = model()
        poll(model)
        await { model.state.value.dashboard != null }
        server.takeRequest()
        advance(2000)
        await { model.state.value.lastError == "Refresh failed" }
        assertTrue(model.state.value.offline)
        assertEquals(dashboard, model.state.value.dashboard)
        assertEquals("cached", server.takeRequest().getHeader("If-None-Match"))
        advance(4999)
        assertEquals(2, server.requestCount)
        assertTrue(model.state.value.offline)
        advance(1)
        await { baselines.size == 2 }
        assertFalse(model.state.value.offline)
        assertNull(model.state.value.lastError)
        assertEquals(dashboard, model.state.value.dashboard)
        assertEquals("cached", server.takeRequest().getHeader("If-None-Match"))
    }

    @Test fun changedCertificateKeepsCachedRowsOfflineUntilPinned304Recovery() = runBlocking {
        val dashboard = Dashboard(1, threads = listOf(Thread(id = "cached")))
        server.protocols = listOf(Protocol.HTTP_1_1)
        server.enqueue(response(dashboard).setHeader("Connection", "close"))
        val model = model()
        poll(model)
        await { model.state.value.dashboard != null }
        val other = HeldCertificate.Builder().commonName("Different PC").ecdsa256().build()
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(other).build().sslSocketFactory(), false)
        server.enqueue(MockResponse().setResponseCode(304))
        advance(5000)
        await { model.state.value.lastError == AsbError.PinMismatch.message }
        assertTrue(model.state.value.offline)
        assertEquals(dashboard, model.state.value.dashboard)
        assertEquals(1, baselines.size)

        server.useHttps(certificates.sslSocketFactory(), false)
        advance(4999)
        assertTrue(model.state.value.offline)
        assertEquals(1, baselines.size)
        advance(1)
        await { baselines.size == 2 }
        assertFalse(model.state.value.offline)
        assertNull(model.state.value.lastError)
        assertEquals(dashboard, model.state.value.dashboard)
    }

    @Test fun cancelingTheScreenPollCannotCommitAnArrivingResponseAndAllowsRestart() = runBlocking {
        server.enqueue(response(Dashboard(1)).throttleBody(1, 1, TimeUnit.SECONDS))
        val model = model()
        val polling = poll(model)
        await { server.requestCount == 1 }
        server.takeRequest()
        polling.cancel()
        await { polling.isCompleted }
        assertNull(model.state.value.dashboard)
        assertTrue(baselines.isEmpty())

        server.enqueue(response(Dashboard(2)))
        poll(model)
        await { model.state.value.dashboard?.generatedAtMs == 2L }
        assertEquals(1, baselines.size)
    }

    @Test fun pinMovesUseVisibleNeighborsAndBoundariesSendNothing() = runBlocking {
        val dashboard = Dashboard(1, threads = listOf(
            Thread(id = "first", title = "visible first", state = "idle", pinned = true, pinIndex = 0),
            Thread(id = "hidden", title = "hidden", state = "idle", pinned = true, pinIndex = 1),
            Thread(id = "last", title = "visible last", state = "idle", pinned = true, pinIndex = 2),
        ))
        val model = model()
        load(model, dashboard)
        model.setFilter(Filter(query = "visible"))
        model.action("first", "pin-up")
        await { model.state.value.busyIds.isEmpty() }
        assertEquals("Already first", model.state.value.banner)
        model.action("last", "pin-down")
        await { model.state.value.busyIds.isEmpty() }
        assertEquals("Already last", model.state.value.banner)
        assertEquals(1, server.requestCount)

        server.enqueue(MockResponse().setBody("{}"))
        server.enqueue(response(dashboard.copy(generatedAtMs = 2)))
        model.action("last", "pin-up")
        await { model.state.value.dashboard?.generatedAtMs == 2L }
        val move = server.takeRequest()
        assertEquals("/phone/v1/threads/last/move-pin", move.path)
        assertEquals("{\"targetId\":\"first\",\"placement\":\"before\"}", move.body.readUtf8())
        val refresh = server.takeRequest()
        assertEquals("/phone/v1/dashboard", refresh.path)
        assertNull(refresh.getHeader("If-None-Match"))
    }

    @Test fun duplicateBusyRowActionsAreIgnoredAndOtherRowsKeepTheirOwnBusyState() = runBlocking {
        val dashboard = Dashboard(1, threads = listOf(
            Thread(id = "one", canOpen = true), Thread(id = "two", canOpen = true),
        ))
        val model = model()
        load(model, dashboard)
        val release = CountDownLatch(1)
        var generation = 1L
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/phone/v1/threads/one/open" -> {
                    assertTrue(release.await(5, TimeUnit.SECONDS))
                    MockResponse().setBody("{\"opened\":true}")
                }
                "/phone/v1/dashboard" -> response(dashboard.copy(generatedAtMs = ++generation))
                else -> MockResponse().setBody("{}")
            }
        }
        model.action("one", "open")
        model.action("one", "open")
        model.action("two", "mark-read")
        assertEquals(setOf("one", "two"), model.state.value.busyIds)
        await { server.requestCount == 2 }
        assertEquals("/phone/v1/threads/one/open", server.takeRequest().path)
        assertEquals(2, server.requestCount)
        release.countDown()
        await { model.state.value.dashboard?.generatedAtMs == 3L }
        assertTrue(model.state.value.busyIds.isEmpty())
        assertEquals("Opened on Test PC", model.state.value.banner)
        assertEquals("/phone/v1/dashboard", server.takeRequest().path)
        assertEquals("/phone/v1/threads/two/mark-read", server.takeRequest().path)
        assertEquals("/phone/v1/dashboard", server.takeRequest().path)
        assertEquals(5, server.requestCount)
    }

    @Test fun openNeedsExplicitConfirmationAndActionErrorsLeaveRowsUsable() = runBlocking {
        val dashboard = Dashboard(1, threads = listOf(Thread(id = "one", canOpen = true), Thread(id = "no-link")))
        val model = model()
        load(model, dashboard)
        for (body in listOf("{\"opened\":false}", "{}", "{\"opened\":{}}", "{\"opened\":\"true\"}", "{\"opened\":1}")) {
            server.enqueue(MockResponse().setBody(body))
            model.action("one", "open")
            await { model.state.value.busyIds.isEmpty() }
            assertEquals("ASB did not open this session. Try again.", model.state.value.lastError)
            assertFalse(model.state.value.offline)
            assertNull(model.state.value.banner)
            server.takeRequest()
            model.clearError()
        }
        server.enqueue(MockResponse().setResponseCode(500).setBody("{\"error\":\"Cannot change row\"}"))
        model.action("one", "mark-read")
        await { model.state.value.busyIds.isEmpty() }
        assertEquals("Cannot change row", model.state.value.lastError)
        assertFalse(model.state.value.offline)
        assertEquals(dashboard, model.state.value.dashboard)
        model.clearError()
        assertNull(model.state.value.lastError)
        model.action("no-link", "open")
        assertEquals("This session has no direct link.", model.state.value.banner)
        model.dismissBanner()
        assertNull(model.state.value.banner)
        assertEquals(7, server.requestCount)
    }

    @Test fun rowValidationAndServerErrorsCannotClearAnExistingDashboardFailure() = runBlocking {
        val dashboard = Dashboard(1, threads = listOf(Thread(id = "one", canOpen = true)))
        val model = model()
        load(model, dashboard)
        server.enqueue(MockResponse().setResponseCode(500).setBody("{\"error\":\"Refresh failed\"}"))
        model.refresh()
        await { !model.state.value.refreshing }
        assertTrue(model.state.value.offline)

        server.enqueue(MockResponse().setBody("{\"opened\":false}"))
        model.action("one", "open")
        await { model.state.value.busyIds.isEmpty() }
        assertTrue(model.state.value.offline)
        server.enqueue(MockResponse().setResponseCode(500).setBody("{\"error\":\"Cannot change row\"}"))
        model.action("one", "mark-read")
        await { model.state.value.busyIds.isEmpty() }
        assertTrue(model.state.value.offline)
        assertEquals("Cannot change row", model.state.value.lastError)
        assertEquals(dashboard, model.state.value.dashboard)
    }

    @Test fun unauthorizedStopsPollingAndRejectsFurtherReadsAndActions() = runBlocking {
        val dashboard = Dashboard(1, threads = listOf(Thread(id = "one", canOpen = true)))
        val model = model()
        server.enqueue(response(dashboard))
        server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        val polling = poll(model)
        await { model.state.value.dashboard != null }
        advance(5000)
        await { model.state.value.revoked && polling.isCompleted }
        assertTrue(revoked)
        assertEquals(dashboard, model.state.value.dashboard)
        model.refresh()
        model.action("one", "open")
        advance(60000)
        assertEquals(2, server.requestCount)
    }
}
