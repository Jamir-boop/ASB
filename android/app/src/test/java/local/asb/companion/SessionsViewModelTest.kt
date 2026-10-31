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
import kotlinx.coroutines.flow.MutableStateFlow
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
import local.asb.companion.data.Palette
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.serialization.json.Json
import local.asb.companion.data.Thread
import local.asb.companion.data.Endpoint
import local.asb.companion.data.Engine
import local.asb.companion.data.Mark
import local.asb.companion.net.AsbApi
import local.asb.companion.net.MemoryEngines
import local.asb.companion.net.MemoryPaths
import local.asb.companion.net.AsbError
import local.asb.companion.net.sha256Hex
import local.asb.companion.notify.BIT_DONE
import local.asb.companion.notify.BIT_FAILED
import local.asb.companion.notify.diff
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
    private val baselines = mutableListOf<Map<String, Mark>>()
    private val palettes = mutableListOf<Palette>()
    private lateinit var server: MockWebServer
    private lateinit var fingerprint: String
    private lateinit var certificates: HandshakeCertificates
    private var revoked = false
    private val networks = MutableStateFlow(0L)
    private val helloReply = MockResponse().setBody("""{"api":1,"asbVersion":"1.8.1","deviceId":"0123456789ab","serverName":"Test PC"}""")

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

    private fun model(
        mutex: Mutex = Mutex(),
        initiallyRevoked: Boolean = false,
        loadBaseline: (String) -> Map<String, Mark>? = { baselines.lastOrNull() },
        saveBaseline: (Map<String, Mark>, String) -> Unit = { baseline, _ -> baselines += baseline },
        initialView: String = "comfortable",
        savePalette: (Palette) -> Unit = { palettes += it },
        networks: MutableStateFlow<Long> = this.networks,
        paths: MemoryPaths = MemoryPaths(listOf(Endpoint("lan", "127.0.0.1"))),
        engines: MemoryEngines = MemoryEngines(),
    ): SessionsViewModel {
        val api = AsbApi(paths, server.port, fingerprint, "t".repeat(43), engines) { revoked = true }
        return SessionsViewModel(api, "Test PC", initiallyRevoked, saveBaseline, mutex, loadBaseline, initialView, savePalette,
            networkChanges = networks).also { models.put("sessions", it) }
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

    // The poll reads hello once after its first good dashboard; then it waits for a network change or its next read.
    private suspend fun takeHello(flow: MutableStateFlow<Long> = networks) {
        assertEquals("/phone/v1/hello", server.takeRequest().path)
        await { flow.subscriptionCount.value > 0 }
    }

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
        server.enqueue(helloReply)
        server.enqueue(MockResponse().setResponseCode(304))
        server.enqueue(response(idle, "two"))
        server.enqueue(MockResponse().setResponseCode(304))
        val model = model()
        val first = poll(model)
        await { baselines.size == 1 }
        assertNull(server.takeRequest().getHeader("If-None-Match"))
        takeHello()
        assertEquals(mapOf("one" to Mark(1)), baselines.single())
        val dashboard = model.state.value.dashboard
        val duplicate = poll(model)
        scheduler.runCurrent()
        assertTrue(duplicate.isCompleted)

        advance(1999)
        assertEquals(2, server.requestCount)
        advance(1)
        await { baselines.size == 2 }
        assertEquals("one", server.takeRequest().getHeader("If-None-Match"))
        assertSame(dashboard, model.state.value.dashboard)
        advance(2000)
        await { model.state.value.dashboard?.generatedAtMs == 2L }
        assertEquals("one", server.takeRequest().getHeader("If-None-Match"))
        advance(4999)
        assertEquals(4, server.requestCount)
        advance(1)
        await { baselines.size == 4 }
        assertEquals("two", server.takeRequest().getHeader("If-None-Match"))
        first.cancel()
        scheduler.runCurrent()
        advance(60000)
        assertEquals(5, server.requestCount)
    }

    @Test fun offlineBackoffKeepsCachedDataCapsAt30SecondsAndResetsOnSuccess() = runBlocking {
        val dashboard = Dashboard(1, threads = listOf(Thread(id = "cached")))
        server.enqueue(response(dashboard))
        server.enqueue(helloReply)
        repeat(4) { server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)) }
        server.enqueue(response(dashboard.copy(generatedAtMs = 2)))
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        server.enqueue(response(dashboard.copy(generatedAtMs = 3)))
        val model = model()
        poll(model)
        await { model.state.value.dashboard != null }
        server.takeRequest()
        takeHello()

        for ((index, waitMs) in listOf(5000L, 5000L, 10000L, 30000L).withIndex()) {
            model.clearError()
            advance(waitMs - 1)
            assertEquals(index + 2, server.requestCount)
            advance(1)
            await { model.state.value.lastError != null }
            assertTrue(model.state.value.offline)
            assertEquals(dashboard, model.state.value.dashboard)
            server.takeRequest()
        }
        advance(29999)
        assertEquals(6, server.requestCount)
        advance(1)
        await { model.state.value.dashboard?.generatedAtMs == 2L }
        assertFalse(model.state.value.offline)
        // The top bar names the path of the last good dashboard.
        assertEquals("lan", model.state.value.path)
        server.takeRequest()
        advance(5000)
        await { model.state.value.offline }
        server.takeRequest()
        advance(4999)
        assertEquals(8, server.requestCount)
        advance(1)
        await { model.state.value.dashboard?.generatedAtMs == 3L }
        assertFalse(model.state.value.offline)
    }

    @Test fun aNetworkChangeWakesTheOfflinePollRetriesAfter3SecondsAndLearnsNewAddresses() = runBlocking {
        val dashboard = Dashboard(1, threads = listOf(Thread(id = "cached")))
        server.enqueue(response(dashboard))
        server.enqueue(helloReply)
        repeat(5) { server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)) }
        server.enqueue(response(dashboard.copy(generatedAtMs = 2)))
        val lan = Endpoint("lan", "127.0.0.1")
        val zerotier = Endpoint("zerotier", "127.0.0.3")
        server.enqueue(MockResponse().setBody("""{"api":1,"asbVersion":"1.8.1","deviceId":"0123456789ab","serverName":"Test PC",""" +
            """"addresses":[{"kind":"zerotier","address":"127.0.0.3"},{"kind":"lan","address":"127.0.0.1"}],"port":4630}"""))
        val networks = MutableStateFlow(0L)
        val paths = MemoryPaths(listOf(lan))
        val model = model(networks = networks, paths = paths)
        poll(model)
        await { model.state.value.dashboard != null }
        server.takeRequest()
        takeHello(networks)
        // The normal backoff reaches the 30 s step.
        for ((index, waitMs) in listOf(5000L, 5000L, 10000L).withIndex()) {
            model.clearError()
            advance(waitMs)
            await { model.state.value.lastError != null }
            assertEquals(index + 3, server.requestCount)
            server.takeRequest()
        }
        // The user turns on ZeroTier: the poll reads now, not after 30 s.
        model.clearError()
        networks.value = 1L
        await { model.state.value.lastError != null }
        assertEquals(6, server.requestCount)
        server.takeRequest()
        model.clearError()
        advance(2999)
        assertEquals(6, server.requestCount)
        advance(1)
        await { model.state.value.lastError != null }
        server.takeRequest()
        advance(4999)
        assertEquals(7, server.requestCount)
        advance(1)
        await { model.state.value.dashboard?.generatedAtMs == 2L }
        assertEquals("/phone/v1/dashboard", server.takeRequest().path)
        // The first good dashboard after the change also reads hello, which adds the new ZeroTier address.
        await { paths.endpoints.size == 2 }
        assertEquals("/phone/v1/hello", server.takeRequest().path)
        assertEquals(listOf(lan, zerotier), paths.endpoints)
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

    @Test fun foregroundLimitSnapshotsAnd304SaveResultBitsInsideTheTransaction() = runBlocking {
        val nowMs = System.currentTimeMillis()
        // A usage limit no longer hides attention, so the limited rows keep their result marks.
        val limited = Dashboard(1, threads = listOf(
            Thread(id = "done", state = "idle", completionAttention = true, limitResetsAtMs = nowMs + 3600000),
            Thread(id = "failed", state = "idle", failedAttention = true, limitResetsAtMs = nowMs + 3600000),
        ))
        var stored: Map<String, Mark>? = mapOf("done" to Mark(BIT_DONE), "failed" to Mark(BIT_FAILED), "gone" to Mark(BIT_DONE))
        val mutex = Mutex(locked = true)
        var reads = 0
        val model = model(mutex, loadBaseline = {
            assertTrue(mutex.isLocked)
            reads++
            stored
        }, saveBaseline = { baseline, _ ->
            assertTrue(mutex.isLocked)
            stored = baseline
            baselines += baseline
        })
        server.enqueue(response(limited))
        model.refresh()
        scheduler.runCurrent()
        assertEquals(0, reads)
        mutex.unlock()
        await { !model.state.value.refreshing }
        assertEquals(BIT_DONE, stored!!.getValue("done").bits and (BIT_DONE or BIT_FAILED))
        assertEquals(BIT_FAILED, stored!!.getValue("failed").bits and (BIT_DONE or BIT_FAILED))
        // A row missing from the update keeps its bits, so it cannot notify again when it comes back.
        assertEquals(BIT_DONE, stored!!.getValue("gone").bits)
        val afterLimit = stored

        server.enqueue(MockResponse().setResponseCode(304))
        val polling = poll(model)
        await { baselines.size == 2 }
        polling.cancel()
        scheduler.runCurrent()
        assertEquals(afterLimit, stored)
        val reset = limited.copy(generatedAtMs = 2, threads = listOf(
            Thread(id = "done", state = "idle", completionAttention = true),
            Thread(id = "failed", state = "idle", failedAttention = true),
        ))
        assertTrue(diff(stored, reset.threads, nowMs).isEmpty())
        server.enqueue(response(reset))
        model.refresh()
        await { !model.state.value.refreshing }
        assertEquals(mapOf("done" to Mark(BIT_DONE), "failed" to Mark(BIT_FAILED), "gone" to Mark(BIT_DONE)), stored)
        assertEquals(3, reads)
    }

    @Test fun serverDashboardFailureKeepsCachedRowsOfflineUntil304AndRetriesAfter5Seconds() = runBlocking {
        val dashboard = Dashboard(1, refreshIntervalMs = 2000, threads = listOf(Thread(id = "cached")))
        server.enqueue(response(dashboard, "cached"))
        server.enqueue(helloReply)
        server.enqueue(MockResponse().setResponseCode(500).setBody("{\"error\":\"Refresh failed\"}"))
        server.enqueue(MockResponse().setResponseCode(304))
        val model = model()
        poll(model)
        await { model.state.value.dashboard != null }
        server.takeRequest()
        takeHello()
        advance(2000)
        await { model.state.value.lastError == "Refresh failed" }
        assertTrue(model.state.value.offline)
        assertEquals(dashboard, model.state.value.dashboard)
        assertEquals("cached", server.takeRequest().getHeader("If-None-Match"))
        advance(4999)
        assertEquals(3, server.requestCount)
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
        server.enqueue(helloReply.setHeader("Connection", "close"))
        val model = model()
        poll(model)
        await { model.state.value.dashboard != null }
        server.takeRequest()
        takeHello()
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

    @Test fun aRowStaysBusyUntilTheBoardRefreshAfterItsAction() = runBlocking {
        val dashboard = Dashboard(1, threads = listOf(Thread(id = "one", canOpen = true)))
        val model = model()
        load(model, dashboard)
        val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/phone/v1/dashboard" -> {
                    assertTrue(release.await(5, TimeUnit.SECONDS))
                    response(dashboard.copy(generatedAtMs = 2))
                }
                else -> MockResponse().setBody("{\"opened\":true}")
            }
        }
        model.action("one", "open")
        assertEquals(setOf("one"), model.state.value.openingIds)
        await { server.requestCount == 3 }
        await { model.state.value.openingIds.isEmpty() }
        assertEquals(setOf("one"), model.state.value.busyIds)
        release.countDown()
        await { model.state.value.dashboard?.generatedAtMs == 2L }
        await { model.state.value.busyIds.isEmpty() }
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

    @Test fun actionErrorsSurviveSuccessfulPollsUntilTheRowActsChangesOrLeaves() = runBlocking {
        val dashboard = Dashboard(1, threads = listOf(Thread(id = "one", state = "idle"), Thread(id = "two")))
        val model = model()
        load(model, dashboard)
        suspend fun fail() {
            server.enqueue(MockResponse().setResponseCode(500).setBody("{\"error\":\"Cannot change row\"}"))
            model.action("one", "drawer-in")
            await { model.state.value.busyIds.isEmpty() }
            assertEquals("Cannot change row", model.state.value.lastError)
            assertEquals(mapOf("one" to "Cannot change row"), model.state.value.actionErrors)
        }
        suspend fun refresh(reply: MockResponse) {
            server.enqueue(reply)
            model.refresh()
            await { !model.state.value.refreshing }
        }
        fail()
        for (reply in listOf(response(dashboard.copy(generatedAtMs = 2)), MockResponse().setResponseCode(304))) {
            refresh(reply)
            assertFalse(model.state.value.offline)
            assertEquals("Cannot change row", model.state.value.lastError)
            assertEquals(mapOf("one" to "Cannot change row"), model.state.value.actionErrors)
        }
        // An action that cannot reach ASB sets offline, so the next good poll clears its snackbar but not its row error.
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        model.action("one", "drawer-in")
        await { model.state.value.busyIds.isEmpty() }
        assertTrue(model.state.value.offline)
        val message = model.state.value.lastError!!
        refresh(response(dashboard.copy(generatedAtMs = 2)))
        assertFalse(model.state.value.offline)
        assertNull(model.state.value.lastError)
        assertEquals(mapOf("one" to message), model.state.value.actionErrors)
        fail()
        server.enqueue(MockResponse().setBody("{}"))
        server.enqueue(response(dashboard.copy(generatedAtMs = 3)))
        model.action("one", "drawer-in")
        await { model.state.value.busyIds.isEmpty() }
        assertEquals(emptyMap<String, String>(), model.state.value.actionErrors)
        assertNull(model.state.value.lastError)

        fail()
        refresh(response(dashboard.copy(generatedAtMs = 4, threads = listOf(Thread(id = "one", state = "working")))))
        assertEquals(emptyMap<String, String>(), model.state.value.actionErrors)
        assertNull(model.state.value.lastError)
        fail()
        refresh(response(dashboard.copy(generatedAtMs = 5, threads = listOf(Thread(id = "two")))))
        assertEquals(emptyMap<String, String>(), model.state.value.actionErrors)
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
        server.enqueue(helloReply)
        server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        val polling = poll(model)
        await { model.state.value.dashboard != null }
        server.takeRequest()
        takeHello()
        advance(5000)
        await { model.state.value.revoked && polling.isCompleted }
        assertTrue(revoked)
        assertEquals(dashboard, model.state.value.dashboard)
        model.refresh()
        model.action("one", "open")
        advance(60000)
        assertEquals(3, server.requestCount)
    }

    @Test fun rotationKeepsFiltersSearchViewAndAnchorInTheRetainedModel() {
        val api = AsbApi(MemoryPaths(listOf(Endpoint("lan", "127.0.0.1"))), server.port, fingerprint, "t".repeat(43)) {}
        val factory = viewModelFactory { initializer { SessionsViewModel(api, "Test PC", initialView = "compact") } }
        val owner = ViewModelStore()
        val original = ViewModelProvider.create(owner, factory)[SessionsViewModel::class]
        assertEquals("compact", original.state.value.view)
        val filter = Filter(query = "cl: plan", app = "codex", states = setOf("working"), archived = true, drawerOnly = true)
        original.setFilter(filter)
        original.setView("comfortable")
        original.anchorId = "two"

        val recreated = ViewModelProvider.create(owner, factory)[SessionsViewModel::class]
        assertSame(original, recreated)
        assertEquals(filter, recreated.state.value.filter)
        assertEquals("comfortable", recreated.state.value.view)
        assertEquals("two", recreated.anchorId)
        owner.clear()
    }

    @Test fun dashboardPaletteIsSavedAndAbsentPaletteKeepsTheSavedOne() = runBlocking {
        val model = model()
        load(model, Dashboard(1))
        assertTrue(palettes.isEmpty())
        val colors = """{"mode":"custom","colors":{"background":"#101418","text":"#e8e4dc","accent":"#f0b45a",""" +
            """"muted":"#a8a29a","divider":"#3a3f46","success":"#f0b45a","warning":"#f0b45a"}}"""
        load(model, Dashboard(2, palette = Json.parseToJsonElement(colors)))
        assertEquals(Palette.parse(Json.parseToJsonElement(colors)), palettes.single())
        assertEquals("custom", palettes.single().mode)
    }

    @Test fun successfulReadShowsTheConfirmationFor1600Ms() = runBlocking {
        val model = model()
        load(model, Dashboard(1, threads = listOf(Thread(id = "one", state = "idle", unread = true))))
        server.enqueue(MockResponse().setBody("{}"))
        server.enqueue(response(Dashboard(2, threads = listOf(Thread(id = "one", state = "idle")))))
        model.action("one", "mark-read")
        await { model.state.value.dashboard?.generatedAtMs == 2L }
        assertEquals(setOf("one"), model.state.value.readConfirmedIds)
        assertTrue(model.state.value.openingIds.isEmpty())
        advance(1599)
        assertEquals(setOf("one"), model.state.value.readConfirmedIds)
        advance(1)
        assertTrue(model.state.value.readConfirmedIds.isEmpty())
    }

    @Test fun thePollReadsHelloOnceAtItsStart() = runBlocking {
        server.enqueue(response(Dashboard(1)))
        server.enqueue(helloReply)
        server.enqueue(response(Dashboard(2)))
        val model = model()
        poll(model)
        await { model.state.value.dashboard != null }
        assertEquals("/phone/v1/dashboard", server.takeRequest().path)
        takeHello()
        advance(5000)
        await { model.state.value.dashboard?.generatedAtMs == 2L }
        assertEquals("/phone/v1/dashboard", server.takeRequest().path)
        assertEquals(3, server.requestCount)
    }

    @Test fun actionsGoToTheEngineOfTheDashboardOnScreen() = runBlocking {
        val certificate = HeldCertificate.Builder().commonName("ASB workLP").ecdsa256().build()
        val other = MockWebServer().apply {
            useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
            start(InetAddress.getByName("127.0.0.1"), 0)
        }
        try {
            val pin = sha256Hex(certificate.certificate.encoded)
            val engines = MemoryEngines(listOf(Engine(pin.take(16), "workLP", other.port, pin, listOf(Endpoint("lan", "127.0.0.1")))))
            // The paired PC is down, so the other engine gives the dashboard.
            val model = model(paths = MemoryPaths(listOf(Endpoint("lan", "127.0.0.2"))), engines = engines)
            val dashboard = Dashboard(1, threads = listOf(Thread(id = "m:x:one", canOpen = true)))
            other.enqueue(response(dashboard))
            model.refresh()
            await { !model.state.value.refreshing }
            assertEquals(pin.take(16), model.state.value.engine)
            other.takeRequest()
            other.enqueue(MockResponse().setBody("""{"opened":true}"""))
            other.enqueue(response(dashboard))
            model.action("m:x:one", "open")
            await { model.state.value.banner != null }
            assertEquals("POST", other.takeRequest().method)
            assertEquals("Opened on workLP", model.state.value.banner)
            assertEquals(0, server.requestCount)
        } finally { other.shutdown() }
    }

    @Test fun viewOnlyCardsSayWhereTheSessionRuns() = runBlocking {
        val model = model()
        load(model, Dashboard(1, threads = listOf(Thread(id = "remote", remote = true, machineName = "homeLP"),
            Thread(id = "nameless", remote = true), Thread(id = "cli", surface = "cli"), Thread(id = "app"))))
        for ((id, banner) in listOf("remote" to "On homeLP. Open it on homeLP.", "nameless" to "On another machine. Open it on another machine.",
            "cli" to "Runs in a terminal. ASB does not open CLI sessions.", "app" to "This session has no direct link.")) {
            model.action(id, "open")
            assertEquals(banner, model.state.value.banner)
            model.dismissBanner()
        }
        assertEquals(1, server.requestCount)
    }
}
