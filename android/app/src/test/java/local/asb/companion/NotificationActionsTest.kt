package local.asb.companion

import kotlinx.serialization.json.JsonObject
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Thread
import local.asb.companion.notify.BIT_DONE
import local.asb.companion.notify.BIT_FAILED
import local.asb.companion.notify.BIT_INPUT
import local.asb.companion.notify.actionOpened
import local.asb.companion.notify.diff
import local.asb.companion.notify.mergeActionBaseline
import local.asb.companion.notify.notificationId
import local.asb.companion.notify.notificationTag
import local.asb.companion.notify.update
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationActionsTest {
    @Test fun openRequiresJsonBooleanTrue() {
        for (value in listOf("false", "\"true\"", "\"false\"", "1", "null", "{}", "[]")) {
            assertFalse(actionOpened(AsbJson.parseToJsonElement("{\"opened\":$value}") as JsonObject))
        }
        assertFalse(actionOpened(JsonObject(emptyMap())))
        assertTrue(actionOpened(AsbJson.parseToJsonElement("{\"opened\":true}") as JsonObject))
    }

    @Test fun actionReadKeepsOtherRowsAndAllowsTheNextCompletion() {
        val old = mapOf("read" to BIT_DONE, "other" to BIT_FAILED)
        val baseline = mergeActionBaseline(old, Thread(id = "read"), 1000)!!
        assertEquals(mapOf("read" to 0, "other" to BIT_FAILED), baseline)
        val completed = Thread(id = "read", completionAttention = true)
        assertEquals(listOf(BIT_DONE), diff(baseline, listOf(completed), 1001).map { it.kind })
        assertNull(mergeActionBaseline(null, completed, 1000))
    }

    @Test fun actionReadKeepsTheUsageLimitMarker() {
        val limited = Thread(id = "read", completionAttention = true, limitResetsAtMs = 2000)
        val before = update(null, listOf(limited, Thread(id = "other", failedAttention = true)), 1000)
        val after = mergeActionBaseline(before, limited.copy(completionAttention = false), 1001)!!
        assertEquals(BIT_FAILED, after["other"])
        assertTrue(diff(after, listOf(limited.copy(limitResetsAtMs = 0)), 2000).isEmpty())
    }

    @Test fun stableIdsKeepHashCollisionsSeparateByTag() {
        assertEquals("row:1".hashCode(), notificationId("row", BIT_DONE))
        assertEquals("row:4", notificationTag("row", BIT_INPUT))
        assertEquals(notificationId("Aa", BIT_DONE), notificationId("BB", BIT_DONE))
        assertFalse(notificationTag("Aa", BIT_DONE) == notificationTag("BB", BIT_DONE))
    }
}
