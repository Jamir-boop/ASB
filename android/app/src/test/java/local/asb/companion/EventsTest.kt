package local.asb.companion

import local.asb.companion.data.Thread
import local.asb.companion.notify.BIT_DONE
import local.asb.companion.notify.BIT_FAILED
import local.asb.companion.notify.BIT_INPUT
import local.asb.companion.notify.Event
import local.asb.companion.notify.bits
import local.asb.companion.notify.diff
import local.asb.companion.notify.update
import org.junit.Assert.assertEquals
import org.junit.Test

class EventsTest {
    private val row = Thread(id = "one")

    @Test fun eachAttentionFlagSetsItsBit() {
        assertEquals(0, bits(row))
        assertEquals(1, bits(row.copy(completionAttention = true)))
        assertEquals(2, bits(row.copy(failedAttention = true)))
        assertEquals(4, bits(row.copy(questionAttention = true)))
        assertEquals(4, bits(row.copy(actionRequired = true)))
        assertEquals(4, bits(row.copy(questionAttention = true, actionRequired = true)))
    }

    @Test fun unrelatedStatusDoesNotSetBits() {
        assertEquals(0, bits(row.copy(
            state = "waiting", questionPending = true, nativeUnread = true,
            manualUnread = true, nativeAttention = true, retainedUnread = true,
            unread = true, pending = true, drawer = true, lastOutcome = "failed",
            completionAtMs = 100, failedAtMs = 100,
        )))
    }

    @Test fun firstRunSuppressesExistingAttention() {
        val attention = row.copy(completionAttention = true, failedAttention = true, actionRequired = true)
        assertEquals(emptyList<Event>(), diff(null, listOf(attention)))
        assertEquals(mapOf(row.id to 7), update(listOf(attention)))
    }

    @Test fun eachNewBitEmitsItsOwnEvent() {
        for ((attention, kind) in listOf(
            row.copy(completionAttention = true) to BIT_DONE,
            row.copy(failedAttention = true) to BIT_FAILED,
            row.copy(questionAttention = true) to BIT_INPUT,
            row.copy(actionRequired = true) to BIT_INPUT,
        )) {
            assertEquals(listOf(Event(attention, kind)), diff(mapOf(row.id to 0), listOf(attention)))
        }
    }

    @Test fun newRowsEmitInputThenFailedThenDone() {
        val attention = row.copy(completionAttention = true, failedAttention = true,
            questionAttention = true, actionRequired = true)
        assertEquals(
            listOf(Event(attention, BIT_INPUT), Event(attention, BIT_FAILED), Event(attention, BIT_DONE)),
            diff(mapOf("another" to 7), listOf(attention)),
        )
    }

    @Test fun onlyRisingBitsEmitEvents() {
        val attention = row.copy(completionAttention = true, failedAttention = true, actionRequired = true)
        assertEquals(listOf(Event(attention, BIT_INPUT), Event(attention, BIT_FAILED)),
            diff(mapOf(row.id to BIT_DONE), listOf(attention)))
        assertEquals(emptyList<Event>(), diff(update(listOf(attention)), listOf(row)))
    }

    @Test fun archivedRowsHaveNoAttention() {
        val archived = row.copy(archived = true, completionAttention = true,
            failedAttention = true, questionAttention = true, actionRequired = true)
        assertEquals(0, bits(archived))
        assertEquals(emptyList<Event>(), diff(emptyMap(), listOf(archived)))
        assertEquals(mapOf(row.id to 0), update(listOf(archived)))
    }

    @Test fun unchangedBitsDoNotEmitWhenTimestampsChange() {
        val done = row.copy(completionAttention = true, completionAtMs = 100)
        assertEquals(emptyList<Event>(), diff(update(listOf(done)),
            listOf(done.copy(completionAtMs = 200, updatedAtMs = 200))))
    }

    @Test fun drawerInDoesNotEmitAnEvent() {
        val done = row.copy(completionAttention = true, unread = true, pending = true)
        val drawer = done.copy(drawer = true, unread = false, pending = false)
        assertEquals(emptyList<Event>(), diff(update(listOf(done)), listOf(drawer)))
        assertEquals(emptyList<Event>(), diff(mapOf(row.id to 0), listOf(row.copy(drawer = true))))
    }

    @Test fun readThenNewCompletionEmitsAgain() {
        val done = row.copy(completionAttention = true, completionAtMs = 100)
        val read = done.copy(completionAttention = false)
        assertEquals(emptyList<Event>(), diff(update(listOf(done)), listOf(read)))
        val next = done.copy(completionAtMs = 200)
        assertEquals(listOf(Event(next, BIT_DONE)), diff(update(listOf(read)), listOf(next)))
    }

    @Test fun updateDropsRowsThatAreNoLongerCurrent() {
        val done = row.copy(completionAttention = true)
        val other = Thread(id = "other", actionRequired = true)
        assertEquals(mapOf(row.id to BIT_DONE, other.id to BIT_INPUT), update(listOf(done, other)))
        assertEquals(mapOf(other.id to BIT_INPUT), update(listOf(other)))
        assertEquals(emptyMap<String, Int>(), update(emptyList()))
    }
}
