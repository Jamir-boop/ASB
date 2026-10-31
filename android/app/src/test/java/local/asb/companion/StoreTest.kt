package local.asb.companion

import android.content.SharedPreferences
import kotlinx.serialization.encodeToString
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Endpoint
import local.asb.companion.data.Engine
import local.asb.companion.data.Mark
import local.asb.companion.data.PairReply
import local.asb.companion.data.PairingInfo
import local.asb.companion.data.Store
import local.asb.companion.notify.BIT_DONE
import local.asb.companion.notify.BIT_FAILED
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** SharedPreferences in memory, so the Store runs in a JVM test. */
private class MemoryPreferences(val values: MutableMap<String, Any?> = mutableMapOf()) : SharedPreferences {
    override fun getAll(): Map<String, *> = values.toMap()
    override fun getString(key: String, defValue: String?) = values[key] as String? ?: defValue
    @Suppress("UNCHECKED_CAST")
    override fun getStringSet(key: String, defValues: Set<String>?) = values[key] as Set<String>? ?: defValues
    override fun getInt(key: String, defValue: Int) = values[key] as Int? ?: defValue
    override fun getLong(key: String, defValue: Long) = values[key] as Long? ?: defValue
    override fun getFloat(key: String, defValue: Float) = values[key] as Float? ?: defValue
    override fun getBoolean(key: String, defValue: Boolean) = values[key] as Boolean? ?: defValue
    override fun contains(key: String) = key in values
    override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) = Unit
    override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) = Unit
    override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
        private val changes = mutableMapOf<String, Any?>()
        private val removed = mutableSetOf<String>()
        private var clear = false
        override fun putString(key: String, value: String?) = apply { changes[key] = value }
        override fun putStringSet(key: String, values: Set<String>?) = apply { changes[key] = values }
        override fun putInt(key: String, value: Int) = apply { changes[key] = value }
        override fun putLong(key: String, value: Long) = apply { changes[key] = value }
        override fun putFloat(key: String, value: Float) = apply { changes[key] = value }
        override fun putBoolean(key: String, value: Boolean) = apply { changes[key] = value }
        override fun remove(key: String) = apply { removed += key }
        override fun clear() = apply { clear = true }
        override fun commit(): Boolean { apply(); return true }
        override fun apply() {
            if (clear) values.clear()
            removed.forEach { values.remove(it) }
            values.putAll(changes)
        }
    }
}

class StoreTest {
    private val token = "t".repeat(43)
    private val lan = Endpoint("lan", "192.168.50.4")
    private val zerotier = Endpoint("zerotier", "10.147.17.4")

    @Test fun savedSingleHostReadsAsOneLanEndpoint() {
        val preferences = MemoryPreferences(mutableMapOf("host" to "192.168.50.4", "port" to 4630, "token" to token))
        val store = Store(preferences)
        assertEquals(listOf(lan), store.endpoints)
        assertNull(store.currentEndpoint)
        store.saveCurrentEndpointIfPaired(token, lan)
        assertEquals(lan, store.currentEndpoint)
        store.saveEndpointsIfPaired(token, listOf(lan, zerotier))
        assertFalse(preferences.contains("host"))
        assertEquals(listOf(lan, zerotier), Store(preferences).endpoints)
    }

    @Test fun pairingSavesTheEndpointsAndWritesNeedTheToken() {
        val store = Store(MemoryPreferences(mutableMapOf("host" to "10.0.0.1", "currentEndpoint" to "{}")))
        store.save(PairingInfo(listOf(lan, zerotier), 4630, "ab".repeat(32), "c".repeat(27), "PC"),
            PairReply(deviceId = "012345abcdef", token = token, serverName = "PC", api = 1))
        assertEquals(listOf(lan, zerotier), store.endpoints)
        assertNull(store.currentEndpoint)
        store.saveEndpointsIfPaired("old", listOf(zerotier))
        store.saveCurrentEndpointIfPaired("old", zerotier)
        assertEquals(listOf(lan, zerotier), store.endpoints)
        assertNull(store.currentEndpoint)
    }

    @Test fun anotherDefaultNetworkStartsAtTheTopAgain() {
        val preferences = MemoryPreferences(mutableMapOf("token" to token))
        val store = Store(preferences)
        store.saveEndpointsIfPaired(token, listOf(lan, zerotier))
        assertTrue(store.networkChanged(7))
        store.saveCurrentEndpointIfPaired(token, zerotier)
        // The same network after a process restart keeps the current endpoint.
        assertFalse(Store(preferences).networkChanged(7))
        assertEquals(zerotier, Store(preferences).currentEndpoint)
        assertTrue(store.networkChanged(8))
        assertNull(store.currentEndpoint)
    }

    @Test fun dismissedWarningsSurviveANewStore() {
        val preferences = MemoryPreferences()
        assertEquals(emptyMap<String, String>(), Store(preferences).dismissedWarnings)
        Store(preferences).dismissedWarnings = mapOf("claude-desktop-code" to "The remote cache contains only observed sessions.")
        assertEquals(mapOf("claude-desktop-code" to "The remote cache contains only observed sessions."), Store(preferences).dismissedWarnings)
    }

    @Test fun unpairKeepsThePhonePreferencesAndRemovesThePairing() {
        val preferences = MemoryPreferences(mutableMapOf("token" to token, "deviceId" to "012345abcdef"))
        val store = Store(preferences)
        store.textScale = 1.3f
        store.view = "compact"
        store.notifyDone = false
        store.notifyFailed = false
        store.notifyInput = false
        store.liveNotification = false
        store.useCameraArea = false
        store.clear()
        val next = Store(preferences)
        assertEquals("", next.token)
        assertFalse(next.paired)
        assertFalse(preferences.contains("deviceId"))
        assertEquals(1.3f, next.textScale)
        assertEquals("compact", next.view)
        assertFalse(next.useCameraArea)
        assertFalse(next.notifyDone)
        assertFalse(next.notifyFailed)
        assertFalse(next.notifyInput)
        assertFalse(next.liveNotification)
    }

    private val homeLp = Engine("b".repeat(16), "homeLP", 4630, "b".repeat(64), listOf(zerotier))

    @Test fun enginesAndTheCurrentEngineAreSavedOnlyForTheCurrentPairing() {
        val preferences = MemoryPreferences(mutableMapOf("token" to token))
        val store = Store(preferences)
        store.saveEnginesIfPaired("old", listOf(homeLp))
        assertEquals(emptyList<Engine>(), store.engines)
        store.saveEnginesIfPaired(token, listOf(homeLp))
        assertEquals(listOf(homeLp), Store(preferences).engines)
        store.saveCurrentEngineIfPaired("old", homeLp.machineId, zerotier)
        assertEquals("", store.currentEngine)
        store.saveCurrentEngineIfPaired(token, homeLp.machineId, zerotier)
        assertEquals(homeLp.machineId, store.currentEngine)
        assertEquals(zerotier, store.currentEngineEndpoint)
        // An endpoint that is not an address of the current engine reads as none.
        store.saveCurrentEngineIfPaired(token, homeLp.machineId, lan)
        assertNull(store.currentEngineEndpoint)
        // An engine that is no longer in the list reads as the paired PC.
        store.saveEnginesIfPaired(token, emptyList())
        assertEquals("", store.currentEngine)
        store.saveEnginesIfPaired(token, listOf(homeLp))
        store.saveCurrentEngineIfPaired(token, "", null)
        assertFalse(preferences.contains("currentEngine"))
        assertFalse(preferences.contains("currentEngineEndpoint"))
        preferences.values["engines"] = "not JSON"
        assertEquals(emptyList<Engine>(), store.engines)
    }

    @Test fun aNewNetworkForgetsOnlyTheEndpointOfTheCurrentEngine() {
        val preferences = MemoryPreferences(mutableMapOf("token" to token))
        val store = Store(preferences)
        store.saveEnginesIfPaired(token, listOf(homeLp))
        store.saveCurrentEngineIfPaired(token, homeLp.machineId, zerotier)
        assertTrue(store.networkChanged(9))
        assertEquals(homeLp.machineId, store.currentEngine)
        assertNull(store.currentEngineEndpoint)
    }

    @Test fun pairingAndUnpairRemoveTheEnginesAndTheBaselineBelongsToOneEngine() {
        val preferences = MemoryPreferences(mutableMapOf("token" to token))
        val store = Store(preferences)
        store.saveEnginesIfPaired(token, listOf(homeLp))
        store.saveCurrentEngineIfPaired(token, homeLp.machineId, zerotier)
        store.saveBaselineIfPaired(token, """{"one":1}""", homeLp.machineId)
        assertEquals(mapOf("one" to Mark(1)), store.loadBaselineIfPaired(token, homeLp.machineId))
        assertNull(store.loadBaselineIfPaired(token, ""))
        assertNull(store.loadBaselineIfPaired("old", homeLp.machineId))
        store.saveBaselineIfPaired("old", """{"two":1}""", "")
        assertEquals(mapOf("one" to Mark(1)), store.loadBaselineIfPaired(token, homeLp.machineId))
        store.save(PairingInfo(listOf(lan), 4630, "ab".repeat(32), "c".repeat(27), "PC"),
            PairReply(deviceId = "012345abcdef", token = token, serverName = "PC", api = 1))
        for (key in listOf("engines", "currentEngine", "currentEngineEndpoint", "baseline", "baselineEngine")) assertFalse(key, preferences.contains(key))
        store.saveEnginesIfPaired(token, listOf(homeLp))
        store.saveCurrentEngineIfPaired(token, homeLp.machineId, zerotier)
        store.saveBaselineIfPaired(token, "{}", "")
        store.clear()
        for (key in listOf("engines", "currentEngine", "currentEngineEndpoint", "baseline", "baselineEngine")) assertFalse(key, preferences.contains(key))
    }

    @Test fun aBaselineFromBeforeTheEnginesReadsAsNoneOnce() {
        // The first poll after the update then starts a new baseline and posts nothing.
        val preferences = MemoryPreferences(mutableMapOf("token" to token, "baseline" to """{"one":1}"""))
        val store = Store(preferences)
        assertNull(store.loadBaselineIfPaired(token, ""))
        store.saveBaselineIfPaired(token, """{"one":1}""", "")
        assertEquals(mapOf("one" to Mark(1)), store.loadBaselineIfPaired(token, ""))
    }

    @Test fun anOldBitsBaselineMigratesAndTheNewFormRoundTrips() {
        val store = Store(MemoryPreferences(mutableMapOf("token" to token)))
        store.saveBaselineIfPaired(token, """{"one":1,"two":6}""", "")
        assertEquals(mapOf("one" to Mark(1), "two" to Mark(6)), store.loadBaselineIfPaired(token, ""))
        val marks = mapOf("one" to Mark(BIT_DONE, 100, 0), "two" to Mark(BIT_FAILED, 0, 200))
        store.saveBaselineIfPaired(token, AsbJson.encodeToString(marks), "")
        assertEquals(marks, store.loadBaselineIfPaired(token, ""))
        for (value in listOf("[]", "{\"one\":\"x\"}", "{\"one\":{}}", "nope")) {
            store.saveBaselineIfPaired(token, value, "")
            assertNull(value, store.loadBaselineIfPaired(token, ""))
        }
    }
}
