package local.asb.companion

import local.asb.companion.data.AsbJson
import local.asb.companion.data.Dashboard
import local.asb.companion.data.Endpoint
import local.asb.companion.data.Engine
import local.asb.companion.data.Hello
import local.asb.companion.data.Thread
import kotlinx.serialization.encodeToString
import local.asb.companion.data.Message
import kotlinx.serialization.SerializationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelsTest {
    private fun messages(value: String): List<Message> =
        AsbJson.decodeFromString<Dashboard>("""{"messages":$value}""").messages

    @Test fun defaultsKeepOlderDashboardsCompatible() {
        assertTrue(AsbJson.decodeFromString<Dashboard>("{}").messages.isEmpty())
        val board = AsbJson.decodeFromString<Dashboard>("""{"threads":[{"id":"one","limitResetsAtMs":1780000000000}]}""")
        assertEquals(1780000000000L, board.threads.single().limitResetsAtMs)
        assertEquals(Message(), AsbJson.decodeFromString<Message>("{}"))
    }

    @Test fun malformedRecordsDoNotRemoveValidMessagesOrThreads() {
        val board = AsbJson.decodeFromString<Dashboard>("""{
            "threads":[{"id":"kept"}],
            "messages":[null,17,"wrong",[],{},
                {"from":"a","to":"b"},
                {"from":null,"to":"b","atMs":1},
                {"from":7,"to":"b","atMs":1},
                {"from":"a","to":false,"atMs":1},
                {"from":"a","to":"b","atMs":"1"},
                {"from":"a","to":"b","atMs":true},
                {"from":"a","to":"b","atMs":null},
                {"from":"a","to":"b","atMs":[]},
                {"from":"a","to":"b","atMs":{}},
                {"from":"a","to":"b","atMs":1780000000000,"future":"ignored"},
                {"from":"","to":"b","atMs":0}]
        }""")
        assertEquals("kept", board.threads.single().id)
        assertEquals(listOf(Message("a", "b", 1780000000000), Message("", "b", 0)), board.messages)
    }

    @Test fun nonArrayMessageValuesAreEmpty() {
        for (value in listOf("null", "false", "12", "\"wrong\"", "{}", """{"from":"a","to":"b","atMs":1}""")) {
            assertTrue(messages(value).isEmpty())
        }
    }

    @Test fun exactIntegralRepresentationsKeepTheirLongIdentity() {
        val accepted = mapOf(
            "0" to 0L, "-0.0" to 0L, "0e100000" to 0L, "0e-100000" to 0L,
            "1.0" to 1L, "1e3" to 1000L, "-1.000e3" to -1000L,
            "9223372036854775807" to Long.MAX_VALUE,
            "9223372036854775807.000" to Long.MAX_VALUE,
            "9.223372036854775807e18" to Long.MAX_VALUE,
            "-9223372036854775808" to Long.MIN_VALUE,
            "-9.223372036854775808e18" to Long.MIN_VALUE,
        )
        for ((value, expected) in accepted) {
            assertEquals(value, expected, messages("""[{"from":"a","to":"b","atMs":$value}]""").single().atMs)
        }
    }

    @Test fun fractionalTimestampsAreFlooredAndOutOfRangeOnesAreDropped() {
        val floored = mapOf("1.5" to 1L, "1e-1" to 0L, "-1.5" to -2L, "1e-100000" to 0L,
            "1.0000000000000000000000000000000001" to 1L, "1792106050744.051" to 1792106050744L)
        for ((value, expected) in floored) {
            assertEquals(value, expected, messages("""[{"from":"a","to":"b","atMs":$value}]""").single().atMs)
        }
        for (value in listOf("9223372036854775808", "-9223372036854775809", "9223372036854775807.1", "1e100000")) {
            assertTrue(value, messages("""[{"from":"a","to":"b","atMs":$value}]""").isEmpty())
        }
    }

    @Test fun fractionalDashboardTimesDecodeAsFlooredMilliseconds() {
        val board = AsbJson.decodeFromString<Dashboard>("""{
            "generatedAtMs":1792106050999.9,
            "threads":[{"id":"one","updatedAtMs":1792106050744.051,"workingSinceMs":1792106040000.5,
                "failedAtMs":1792106030000.25,"completionAtMs":1792106020000.75,"limitResetsAtMs":1792109650000.5},
                {"id":"two","updatedAtMs":1792106050744}],
            "messages":[{"from":"one","to":"two","atMs":1792106050500.999}]
        }""")
        assertEquals(1792106050999L, board.generatedAtMs)
        val one = board.threads.first()
        assertEquals(listOf(1792106050744L, 1792106040000L, 1792106030000L, 1792106020000L, 1792109650000L),
            listOf(one.updatedAtMs, one.workingSinceMs, one.failedAtMs, one.completionAtMs, one.limitResetsAtMs))
        assertEquals(1792106050744L, board.threads.last().updatedAtMs)
        assertEquals(0L, board.threads.last().failedAtMs)
        assertEquals(listOf(Message("one", "two", 1792106050500)), board.messages)
    }

    @Test fun nonNumericThreadTimesStillFail() {
        for (value in listOf("null", "true", "\"1\"", "[]", "{}", "1e100000")) {
            assertThrows(value, SerializationException::class.java) {
                AsbJson.decodeFromString<Dashboard>("""{"threads":[{"id":"one","updatedAtMs":$value}]}""")
            }
        }
    }

    @Test fun decodingKeepsOrderDuplicatesAndOldMessagesForSelectionRules() {
        val values = messages("""[{"from":"a","to":"b","atMs":1},{"from":"a","to":"b","atMs":1},{"from":"b","to":"a","atMs":0}]""")
        assertEquals(listOf(Message("a", "b", 1), Message("a", "b", 1), Message("b", "a", 0)), values)
    }

    @Test fun threadMachineFieldsDefaultToALocalAppRowAndTheKeyIsTheGlobalId() {
        val local = AsbJson.decodeFromString<Thread>("""{"id":"codex:1"}""")
        assertEquals(listOf("", "", false, "app", ""), listOf(local.machineId, local.machineName, local.remote, local.surface, local.globalId))
        assertEquals("codex:1", local.key)
        val remote = AsbJson.decodeFromString<Thread>("""{"id":"m:bbbbbbbbbbbbbbbb:codex:1","machineId":"bbbbbbbbbbbbbbbb",
            "machineName":"homeLP","remote":true,"surface":"cli","globalId":"bbbbbbbbbbbbbbbb:codex:1"}""")
        assertEquals("bbbbbbbbbbbbbbbb:codex:1", remote.key)
        assertTrue(remote.remote)
        assertEquals("cli", remote.surface)
        // The key has no backing field, so it is not sent or saved.
        assertFalse("key" in AsbJson.encodeToString(remote))
    }

    @Test fun threadAlertReadsTrueAndAnOlderEngineSendsNone() {
        assertTrue(AsbJson.decodeFromString<Thread>("""{"id":"one","alert":true}""").alert)
        assertFalse(AsbJson.decodeFromString<Thread>("""{"id":"one"}""").alert)
    }

    @Test fun helloReadsTheMachineIdAndEnginesAndOlderPcsSendNeither() {
        assertEquals(Pair("", emptyList<Engine>()), AsbJson.decodeFromString<Hello>("""{"api":1}""").let { it.machineId to it.engines })
        val hello = AsbJson.decodeFromString<Hello>("""{"api":1,"machineId":"aaaaaaaaaaaaaaaa","engines":[{"machineId":"bbbbbbbbbbbbbbbb",
            "name":"homeLP","port":4630,"fingerprint":"${"b".repeat(64)}","addresses":[{"kind":"zerotier","address":"10.147.0.2"}],"future":1}]}""")
        assertEquals("aaaaaaaaaaaaaaaa", hello.machineId)
        assertEquals(listOf(Engine("bbbbbbbbbbbbbbbb", "homeLP", 4630, "b".repeat(64), listOf(Endpoint("zerotier", "10.147.0.2")))), hello.engines)
    }
}
