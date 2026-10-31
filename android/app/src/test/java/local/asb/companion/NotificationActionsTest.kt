package local.asb.companion

import kotlinx.serialization.json.JsonObject
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Mark
import local.asb.companion.data.Thread
import local.asb.companion.notify.BIT_DONE
import local.asb.companion.notify.BIT_FAILED
import local.asb.companion.notify.BIT_INPUT
import local.asb.companion.notify.NotificationRow
import local.asb.companion.notify.actionExtras
import local.asb.companion.notify.actionOpened
import local.asb.companion.notify.diff
import local.asb.companion.notify.mergeActionBaseline
import local.asb.companion.notify.notificationId
import local.asb.companion.notify.notificationRow
import local.asb.companion.notify.notificationTag
import local.asb.companion.notify.shouldPost
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
        val old = mapOf("read" to Mark(BIT_DONE), "other" to Mark(BIT_FAILED))
        val baseline = mergeActionBaseline(old, Thread(id = "read"), 1000)!!
        assertEquals(mapOf("read" to Mark(0), "other" to Mark(BIT_FAILED)), baseline)
        val completed = Thread(id = "read", completionAttention = true)
        assertEquals(listOf(BIT_DONE), diff(baseline, listOf(completed), 1001).map { it.kind })
        assertNull(mergeActionBaseline(null, completed, 1000))
    }

    @Test fun actionReadOfALimitedRowClearsItsBitAndTheResetNotifiesNothing() {
        val limited = Thread(id = "read", failedAttention = true, lastOutcome = "limit", limitResetsAtMs = 2000)
        val before = update(null, listOf(limited, Thread(id = "other", failedAttention = true)), 1000)
        val read = limited.copy(failedAttention = false)
        val after = mergeActionBaseline(before, read, 1001)!!
        assertEquals(mapOf("read" to Mark(0), "other" to Mark(BIT_FAILED)), after)
        assertTrue(diff(after, listOf(read.copy(limitResetsAtMs = 0)), 2000).isEmpty())
    }

    @Test fun actionMergeNeverAddsABit() {
        val old = mapOf("row" to Mark(BIT_DONE))
        val grown = Thread(id = "row", completionAttention = true, failedAttention = true, questionAttention = true)
        val merged = mergeActionBaseline(old, grown, 1000)!!
        assertEquals(BIT_DONE, merged["row"]?.bits)
        assertEquals(listOf(BIT_INPUT, BIT_FAILED), diff(merged, listOf(grown), 1001).map { it.kind })
        assertEquals(0, mergeActionBaseline(emptyMap(), grown, 1000)!!["row"]?.bits)
        val limited = grown.copy(limitResetsAtMs = 2000)
        assertEquals(BIT_DONE, mergeActionBaseline(old, limited, 1000)!!["row"]?.bits)
    }

    @Test fun manualCheckPostsWhileTheAppIsResumed() {
        assertTrue(shouldPost(manual = true, resumed = true))
        assertTrue(shouldPost(manual = false, resumed = false))
        assertFalse(shouldPost(manual = false, resumed = true))
    }

    @Test fun stableIdsKeepHashCollisionsSeparateByTag() {
        assertEquals("row:1".hashCode(), notificationId("row", BIT_DONE))
        assertEquals("row:4", notificationTag("row", BIT_INPUT))
        assertEquals(notificationId("Aa", BIT_DONE), notificationId("BB", BIT_DONE))
        assertFalse(notificationTag("Aa", BIT_DONE) == notificationTag("BB", BIT_DONE))
    }

    @Test fun actionExtrasNameTheRowOnItsEngineAndTheKeyOnEveryEngine() {
        val row = Thread(id = "m:bbbbbbbbbbbbbbbb:codex:1", globalId = "aaaaaaaaaaaaaaaa:codex:1")
        assertEquals(mapOf("id" to row.id, "key" to row.key, "engine" to "bbbbbbbbbbbbbbbb", "action" to "mark-read", "kind" to BIT_DONE,
            "notificationId" to notificationId("aaaaaaaaaaaaaaaa:codex:1", BIT_DONE), "deviceId" to "012345abcdef"),
            actionExtras(row, BIT_DONE, "mark-read", "bbbbbbbbbbbbbbbb", "012345abcdef"))
        assertEquals(NotificationRow(row.id, row.key, "bbbbbbbbbbbbbbbb"), notificationRow(row.id, row.key, "bbbbbbbbbbbbbbbb"))
        // A notification from before the update has only the row ID: the key is the ID and the engine is the paired PC.
        assertEquals(NotificationRow("codex:1", "codex:1", ""), notificationRow("codex:1", null, null))
        assertEquals(NotificationRow("codex:1", "codex:1", ""), notificationRow("codex:1", "", null))
        assertNull(notificationRow("", "key", ""))
        assertNull(notificationRow(null, "key", ""))
    }

    @Test fun actionMergeKeepsTheOldTimes() {
        val old = mapOf("row" to Mark(BIT_DONE or BIT_FAILED, 100, 200))
        val read = Thread(id = "row", completionAtMs = 300, failedAtMs = 400)
        assertEquals(mapOf("row" to Mark(0, 100, 200)), mergeActionBaseline(old, read, 1000))
    }

    @Test fun actionBaselineMergesByKey() {
        val row = Thread(id = "m:bbbbbbbbbbbbbbbb:codex:1", globalId = "aaaaaaaaaaaaaaaa:codex:1")
        assertEquals(mapOf("aaaaaaaaaaaaaaaa:codex:1" to Mark(0)), mergeActionBaseline(mapOf("aaaaaaaaaaaaaaaa:codex:1" to Mark(BIT_DONE)), row, 1000))
    }
}
