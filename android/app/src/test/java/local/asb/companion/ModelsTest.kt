package local.asb.companion

import local.asb.companion.data.AsbJson
import local.asb.companion.data.Dashboard
import local.asb.companion.data.Message
import org.junit.Assert.assertEquals
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

    @Test fun fractionalAndOutOfRangeTimestampsAreDroppedWithoutRounding() {
        for (value in listOf("1.5", "1e-1", "1.0000000000000000000000000000000001",
            "9223372036854775808", "-9223372036854775809", "9223372036854775807.1", "1e100000", "1e-100000")) {
            assertTrue(value, messages("""[{"from":"a","to":"b","atMs":$value}]""").isEmpty())
        }
    }

    @Test fun decodingKeepsOrderDuplicatesAndOldMessagesForSelectionRules() {
        val values = messages("""[{"from":"a","to":"b","atMs":1},{"from":"a","to":"b","atMs":1},{"from":"b","to":"a","atMs":0}]""")
        assertEquals(listOf(Message("a", "b", 1), Message("a", "b", 1), Message("b", "a", 0)), values)
    }
}
