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
    private val now = 1_800_000_000_000L
    private val reset = now + 60_000L

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
        assertEquals(emptyList<Event>(), diff(null, listOf(attention), now))
        assertEquals(mapOf(row.id to 7), update(null, listOf(attention), now))
    }

    @Test fun eachNewBitEmitsItsOwnEvent() {
        for ((attention, kind) in listOf(
            row.copy(completionAttention = true) to BIT_DONE,
            row.copy(failedAttention = true) to BIT_FAILED,
            row.copy(questionAttention = true) to BIT_INPUT,
            row.copy(actionRequired = true) to BIT_INPUT,
        )) {
            assertEquals(listOf(Event(attention, kind)), diff(mapOf(row.id to 0), listOf(attention), now))
        }
    }

    @Test fun newRowsEmitInputThenFailedThenDone() {
        val attention = row.copy(completionAttention = true, failedAttention = true,
            questionAttention = true, actionRequired = true)
        assertEquals(
            listOf(Event(attention, BIT_INPUT), Event(attention, BIT_FAILED), Event(attention, BIT_DONE)),
            diff(mapOf("another" to 7), listOf(attention), now),
        )
    }

    @Test fun onlyRisingBitsEmitEvents() {
        val attention = row.copy(completionAttention = true, failedAttention = true, actionRequired = true)
        assertEquals(listOf(Event(attention, BIT_INPUT), Event(attention, BIT_FAILED)),
            diff(mapOf(row.id to BIT_DONE), listOf(attention), now))
        assertEquals(emptyList<Event>(), diff(update(null, listOf(attention), now), listOf(row), now))
    }

    @Test fun archivedRowsHaveNoAttention() {
        val archived = row.copy(archived = true, completionAttention = true,
            failedAttention = true, questionAttention = true, actionRequired = true)
        assertEquals(0, bits(archived))
        assertEquals(emptyList<Event>(), diff(emptyMap(), listOf(archived), now))
        assertEquals(mapOf(row.id to 0), update(null, listOf(archived), now))
    }

    @Test fun unchangedBitsDoNotEmitWhenTimestampsChange() {
        val done = row.copy(completionAttention = true, completionAtMs = 100)
        assertEquals(emptyList<Event>(), diff(update(null, listOf(done), now),
            listOf(done.copy(completionAtMs = 200, updatedAtMs = 200)), now))
    }

    @Test fun drawerInDoesNotEmitAnEvent() {
        val done = row.copy(completionAttention = true, unread = true, pending = true)
        val drawer = done.copy(drawer = true, unread = false, pending = false)
        assertEquals(emptyList<Event>(), diff(update(null, listOf(done), now), listOf(drawer), now))
        assertEquals(emptyList<Event>(), diff(mapOf(row.id to 0), listOf(row.copy(drawer = true)), now))
    }

    @Test fun readThenNewCompletionEmitsAgain() {
        val done = row.copy(completionAttention = true, completionAtMs = 100)
        val read = done.copy(completionAttention = false)
        assertEquals(emptyList<Event>(), diff(update(null, listOf(done), now), listOf(read), now))
        val next = done.copy(completionAtMs = 200)
        assertEquals(listOf(Event(next, BIT_DONE)), diff(update(null, listOf(read), now), listOf(next), now))
    }

    @Test fun rowsMissingFromOneUpdateKeepTheirBitsAndDoNotNotifyAgain() {
        val done = row.copy(completionAttention = true)
        val other = Thread(id = "other", actionRequired = true)
        val baseline = update(null, listOf(done, other), now)
        assertEquals(mapOf(row.id to BIT_DONE, other.id to BIT_INPUT), baseline)
        // A provider read fails for one scan: the row is missing but keeps its bits.
        val skipped = update(baseline, listOf(other), now)
        assertEquals(baseline, skipped)
        assertEquals(baseline, update(baseline, emptyList(), now))
        // When it comes back with the same mark, nothing notifies again.
        assertEquals(emptyList<Event>(), diff(skipped, listOf(done, other), now))
    }

    @Test fun codexNativeAttentionOnAnIdleRowIsDone() {
        val native = row.copy(state = "idle", nativeAttention = true)
        assertEquals(BIT_DONE, bits(native))
        assertEquals(0, bits(native.copy(state = "working")))
        assertEquals(0, bits(native.copy(archived = true)))
        assertEquals(listOf(Event(native, BIT_DONE)), diff(mapOf(row.id to 0), listOf(native), now))
    }

    @Test fun codexNativeFailureIsFailedOnly() {
        val success = row.copy(state = "idle", nativeAttention = true)
        val failure = success.copy(lastOutcome = "failed")
        assertEquals(listOf(Event(success, BIT_DONE)), diff(mapOf(row.id to 0), listOf(success), now))
        assertEquals(BIT_FAILED, bits(failure))
        assertEquals(listOf(Event(failure, BIT_FAILED)), diff(mapOf(row.id to 0), listOf(failure), now))
        assertEquals(0, bits(failure.copy(state = "working")))
        assertEquals(emptyList<Event>(), diff(mapOf(row.id to 0), listOf(failure.copy(state = "working")), now))
    }

    @Test fun limitedServerAttentionPreservesOldResultBitsWithoutEvents() {
        for (kind in listOf(BIT_DONE, BIT_FAILED)) {
            val limited = row.copy(state = "idle", limitResetsAtMs = reset,
                completionAttention = kind == BIT_DONE, failedAttention = kind == BIT_FAILED,
                unread = false, pending = false, pendingSource = "")
            assertEquals(kind, bits(limited))
            for (old in 0..3) {
                val baseline = mapOf(row.id to old)
                assertEquals(emptyList<Event>(), diff(baseline, listOf(limited), now))
                val saved = update(baseline, listOf(limited), now)
                assertEquals(old, saved.getValue(row.id) and (BIT_DONE or BIT_FAILED))
                assertEquals(saved, update(saved, listOf(limited), reset - 1))
            }
        }
    }

    @Test fun firstRunAndNewLimitedRowsDoNotNotifyAtReset() {
        val limited = row.copy(completionAttention = true, limitResetsAtMs = reset)
        for (baseline in listOf(null, emptyMap(), mapOf("other" to BIT_FAILED))) {
            assertEquals(emptyList<Event>(), diff(baseline, listOf(limited), now))
            val saved = update(baseline, listOf(limited), now)
            assertEquals(0, saved.getValue(row.id) and (BIT_DONE or BIT_FAILED))
            assertEquals(emptyList<Event>(), diff(saved, listOf(limited.copy(limitResetsAtMs = 0)), reset))
        }
    }

    @Test fun resetRestorationIsSuppressedAndThenStoresCurrentBits() {
        for (kind in listOf(BIT_DONE, BIT_FAILED)) {
            val limited = row.copy(state = "idle", limitResetsAtMs = reset,
                completionAttention = kind == BIT_DONE, failedAttention = kind == BIT_FAILED,
                unread = false, pending = false)
            val saved = update(mapOf(row.id to 0), listOf(limited), now)
            for (resetField in listOf(0L, reset)) {
                val restored = limited.copy(limitResetsAtMs = resetField, unread = true, pending = true)
                assertEquals(emptyList<Event>(), diff(saved, listOf(restored), reset))
                val after = update(saved, listOf(restored), reset)
                assertEquals(mapOf(row.id to kind), after)
                assertEquals(emptyList<Event>(), diff(after, listOf(restored), reset + 1))
            }
        }
    }

    @Test fun inputCanClearAndRiseDuringTheLimitAndAtReset() {
        val limited = row.copy(completionAttention = true, limitResetsAtMs = reset)
        val initial = update(mapOf(row.id to BIT_FAILED), listOf(limited), now)
        val input = limited.copy(questionAttention = true)
        assertEquals(listOf(Event(input, BIT_INPUT)), diff(initial, listOf(input), now))
        val waiting = update(initial, listOf(input), now)
        assertEquals(BIT_FAILED or BIT_INPUT, waiting.getValue(row.id) and 7)
        assertEquals(emptyList<Event>(), diff(waiting, listOf(input), now))
        val cleared = update(waiting, listOf(limited), now)
        assertEquals(BIT_FAILED, cleared.getValue(row.id) and 7)
        val atReset = input.copy(limitResetsAtMs = 0, questionAttention = false, actionRequired = true)
        assertEquals(listOf(Event(atReset, BIT_INPUT)), diff(cleared, listOf(atReset), reset))
        assertEquals(mapOf(row.id to (BIT_DONE or BIT_INPUT)), update(cleared, listOf(atReset), reset))
    }

    @Test fun archivedLimitedRowsClearTheMarkerAndAllAttention() {
        val limited = row.copy(completionAttention = true, limitResetsAtMs = reset)
        val saved = update(mapOf(row.id to 7), listOf(limited), now)
        val archived = limited.copy(archived = true, failedAttention = true, actionRequired = true)
        assertEquals(emptyList<Event>(), diff(saved, listOf(archived), now))
        assertEquals(mapOf(row.id to 0), update(saved, listOf(archived), now))
        // A row missing from an update keeps its stored bits.
        assertEquals(saved, update(saved, emptyList(), now))
    }

    @Test fun observedTaskAfterResetCanCompleteNormally() {
        val limited = row.copy(failedAttention = true, limitResetsAtMs = reset)
        val saved = update(mapOf(row.id to 0), listOf(limited), now)
        val working = row.copy(state = "working", workingSinceMs = reset + 1)
        assertEquals(emptyList<Event>(), diff(saved, listOf(working), reset + 1))
        val workingBaseline = update(saved, listOf(working), reset + 1)
        assertEquals(mapOf(row.id to 0), workingBaseline)
        val done = row.copy(completionAttention = true, completionAtMs = reset + 10_000)
        assertEquals(listOf(Event(done, BIT_DONE)), diff(workingBaseline, listOf(done), reset + 10_000))
    }

    @Test fun completionBetweenResetAndNextPollCannotBeDistinguishedFromRestoration() {
        val limited = row.copy(failedAttention = true, limitResetsAtMs = reset)
        val saved = update(mapOf(row.id to 0), listOf(limited), now)
        val done = row.copy(completionAttention = true, completionAtMs = reset + 10_000)
        assertEquals(emptyList<Event>(), diff(saved, listOf(done), reset + 15_000))
        assertEquals(mapOf(row.id to BIT_DONE), update(saved, listOf(done), reset + 15_000))
    }
}
