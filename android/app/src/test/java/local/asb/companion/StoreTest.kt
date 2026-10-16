package local.asb.companion

import android.content.SharedPreferences
import local.asb.companion.data.Endpoint
import local.asb.companion.data.PairReply
import local.asb.companion.data.PairingInfo
import local.asb.companion.data.Store
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
        store.networkChanged(7)
        store.saveCurrentEndpointIfPaired(token, zerotier)
        // The same network after a process restart keeps the current endpoint.
        Store(preferences).networkChanged(7)
        assertEquals(zerotier, Store(preferences).currentEndpoint)
        store.networkChanged(8)
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
        store.clear()
        val next = Store(preferences)
        assertEquals("", next.token)
        assertFalse(next.paired)
        assertFalse(preferences.contains("deviceId"))
        assertEquals(1.3f, next.textScale)
        assertEquals("compact", next.view)
        assertFalse(next.notifyDone)
        assertFalse(next.notifyFailed)
        assertFalse(next.notifyInput)
    }
}
