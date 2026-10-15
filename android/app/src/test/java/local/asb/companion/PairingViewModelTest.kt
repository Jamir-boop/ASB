package local.asb.companion

import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import local.asb.companion.data.PairReply
import local.asb.companion.ui.PairingViewModel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PairingViewModelTest {
    private val store = ViewModelStore()
    private val link = "asb://pair?v=1&h=192.168.50.4&p=4630&f=${"a".repeat(64)}&c=${"a".repeat(27)}&n=PC"
    private val nextLink = link.replace("c=${"a".repeat(27)}", "c=${"b".repeat(27)}")
    private val reply = PairReply("012345abcdef", "a".repeat(43), "PC", "1.8.1", 1)

    @Before fun mainDispatcher() { Dispatchers.setMain(StandardTestDispatcher()) }
    @After fun clear() { store.clear(); Dispatchers.resetMain() }

    @Test fun recreationKeepsConfirmationAndSavesTheRunningRequestOnce() = runTest {
        val response = CompletableDeferred<PairReply>()
        val saved = mutableListOf<PairReply>()
        val factory = viewModelFactory {
            initializer { PairingViewModel({ _, result -> saved += result }, { _, _ -> response.await() }) }
        }
        val original = ViewModelProvider.create(store, factory)[PairingViewModel::class]
        original.changeInput(link)
        original.review(link)
        original.pair("Phone")
        runCurrent()

        val recreated = ViewModelProvider.create(store, factory)[PairingViewModel::class]
        assertSame(original, recreated)
        assertEquals(link, recreated.input)
        assertEquals("a".repeat(27), recreated.candidate!!.code)
        assertTrue(recreated.busy)
        assertTrue(saved.isEmpty())

        response.complete(reply)
        runCurrent()
        assertEquals(listOf(reply), saved)
        assertTrue(recreated.paired)
        assertFalse(recreated.busy)
    }

    @Test fun resetAfterSuccessAllowsANewPairingInsteadOfReusingSuccess() = runTest {
        val saved = mutableListOf<String>()
        val model = PairingViewModel({ info, _ -> saved += info.code }, { _, _ -> reply })
        store.put("pairing", model)
        model.changeInput(link)
        model.review(link)
        model.pair("Phone")
        runCurrent()
        assertTrue(model.paired)
        assertFalse(model.busy)

        model.reset()
        assertFalse(model.paired)
        assertEquals("", model.input)
        assertNull(model.candidate)
        model.review(nextLink)
        model.pair("Phone")
        runCurrent()
        assertTrue(model.paired)
        assertEquals(listOf("a".repeat(27), "b".repeat(27)), saved)
    }

    @Test fun lateOldResponseCannotSaveOrClearTheNewRequestState() = runTest {
        val oldResponse = CompletableDeferred<PairReply>()
        val newResponse = CompletableDeferred<PairReply>()
        val saved = mutableListOf<String>()
        val model = PairingViewModel({ info, _ -> saved += info.code }, { info, _ ->
            withContext(NonCancellable) {
                if (info.code == "a".repeat(27)) oldResponse.await() else newResponse.await()
            }
        })
        store.put("pairing", model)
        model.review(link)
        model.pair("Phone")
        runCurrent()
        model.reset()
        model.review(nextLink)
        model.pair("Phone")
        runCurrent()

        oldResponse.complete(reply)
        runCurrent()
        assertTrue(saved.isEmpty())
        assertTrue(model.busy)
        assertFalse(model.paired)
        assertEquals("b".repeat(27), model.candidate!!.code)

        newResponse.complete(reply)
        runCurrent()
        assertEquals(listOf("b".repeat(27)), saved)
        assertTrue(model.paired)
        assertFalse(model.busy)
    }

    @Test fun explicitBackCancelsAndKeepsTheManualInput() = runTest {
        val response = CompletableDeferred<PairReply>()
        val saved = mutableListOf<PairReply>()
        val model = PairingViewModel({ _, result -> saved += result }, { _, _ -> response.await() })
        store.put("pairing", model)
        model.changeInput(link)
        model.review(link)
        model.pair("Phone")
        runCurrent()
        model.back()
        response.complete(reply)
        runCurrent()
        assertEquals(link, model.input)
        assertNull(model.candidate)
        assertFalse(model.busy)
        assertFalse(model.paired)
        assertTrue(saved.isEmpty())
    }

    @Test fun oldScannerCallbacksCannotRestoreAResetFlow() {
        val model = PairingViewModel({ _, _ -> })
        store.put("pairing", model)
        val scan = model.startScan()
        model.reset()
        model.scanResult(scan, link)
        model.stopScan(scan, failed = true)
        assertNull(model.candidate)
        assertNull(model.error)
        assertFalse(model.scanning)
    }
}
