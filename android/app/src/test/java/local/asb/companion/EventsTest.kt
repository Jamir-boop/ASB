package local.asb.companion

import local.asb.companion.data.Mark
import local.asb.companion.data.Thread
import local.asb.companion.notify.BIT_DONE
import local.asb.companion.notify.BIT_FAILED
import local.asb.companion.notify.BIT_INPUT
import local.asb.companion.notify.Cleared
import local.asb.companion.notify.Event
import local.asb.companion.notify.bits
import local.asb.companion.notify.cleared
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
        assertEquals(4, bits(row.copy(actionRequired = true, actionAttention = true)))
        // A read required action plays nothing.
        assertEquals(0, bits(row.copy(actionRequired = true, actionAttention = false)))
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
        assertEquals(mapOf(row.id to Mark(7)), update(null, listOf(attention), now))
    }

    @Test fun eachNewBitEmitsItsOwnEvent() {
        for ((attention, kind) in listOf(
            row.copy(completionAttention = true) to BIT_DONE,
            row.copy(failedAttention = true) to BIT_FAILED,
            row.copy(questionAttention = true) to BIT_INPUT,
            row.copy(actionRequired = true) to BIT_INPUT,
        )) {
            assertEquals(listOf(Event(attention, kind)), diff(mapOf(row.id to Mark(0)), listOf(attention), now))
        }
    }

    @Test fun newRowsEmitInputThenFailedThenDone() {
        val attention = row.copy(completionAttention = true, failedAttention = true,
            questionAttention = true, actionRequired = true)
        assertEquals(
            listOf(Event(attention, BIT_INPUT), Event(attention, BIT_FAILED), Event(attention, BIT_DONE)),
            diff(mapOf("another" to Mark(7)), listOf(attention), now),
        )
    }

    @Test fun onlyRisingBitsEmitEvents() {
        val attention = row.copy(completionAttention = true, failedAttention = true, actionRequired = true)
        assertEquals(listOf(Event(attention, BIT_INPUT), Event(attention, BIT_FAILED)),
            diff(mapOf(row.id to Mark(BIT_DONE)), listOf(attention), now))
        assertEquals(emptyList<Event>(), diff(update(null, listOf(attention), now), listOf(row), now))
    }

    @Test fun archivedRowsHaveNoAttention() {
        val archived = row.copy(archived = true, completionAttention = true,
            failedAttention = true, questionAttention = true, actionRequired = true)
        assertEquals(0, bits(archived))
        assertEquals(emptyList<Event>(), diff(emptyMap(), listOf(archived), now))
        assertEquals(mapOf(row.id to Mark(0)), update(null, listOf(archived), now))
    }

    @Test fun aNewerCompletionEmitsAgainAndANewerUpdateDoesNot() {
        val done = row.copy(completionAttention = true, completionAtMs = 100)
        val saved = update(null, listOf(done), now)
        val next = done.copy(completionAtMs = 200)
        assertEquals(listOf(Event(next, BIT_DONE)), diff(saved, listOf(next), now))
        assertEquals(emptyList<Event>(), diff(saved, listOf(done.copy(updatedAtMs = 200)), now))
    }

    @Test fun aNewerFailureEmitsAgain() {
        val failed = row.copy(failedAttention = true, failedAtMs = 100)
        val next = failed.copy(failedAtMs = 200)
        assertEquals(listOf(Event(next, BIT_FAILED)), diff(update(null, listOf(failed), now), listOf(next), now))
    }

    @Test fun anUnknownSavedTimeOrAClearBitEmitsNoTimeEvent() {
        val done = row.copy(completionAttention = true, completionAtMs = 200)
        assertEquals(emptyList<Event>(), diff(mapOf(row.id to Mark(BIT_DONE)), listOf(done), now))
        assertEquals(emptyList<Event>(), diff(mapOf(row.id to Mark(BIT_DONE, 100)), listOf(done.copy(completionAttention = false)), now))
    }

    @Test fun drawerInDoesNotEmitAnEvent() {
        val done = row.copy(completionAttention = true, unread = true, pending = true)
        val drawer = done.copy(drawer = true, unread = false, pending = false)
        assertEquals(emptyList<Event>(), diff(update(null, listOf(done), now), listOf(drawer), now))
        assertEquals(emptyList<Event>(), diff(mapOf(row.id to Mark(0)), listOf(row.copy(drawer = true)), now))
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
        assertEquals(mapOf(row.id to Mark(BIT_DONE), other.id to Mark(BIT_INPUT)), baseline)
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
        assertEquals(listOf(Event(native, BIT_DONE)), diff(mapOf(row.id to Mark(0)), listOf(native), now))
    }

    @Test fun codexNativeFailureIsFailedOnly() {
        val success = row.copy(state = "idle", nativeAttention = true)
        val failure = success.copy(lastOutcome = "failed")
        assertEquals(listOf(Event(success, BIT_DONE)), diff(mapOf(row.id to Mark(0)), listOf(success), now))
        assertEquals(BIT_FAILED, bits(failure))
        assertEquals(listOf(Event(failure, BIT_FAILED)), diff(mapOf(row.id to Mark(0)), listOf(failure), now))
        assertEquals(0, bits(failure.copy(state = "working")))
        assertEquals(emptyList<Event>(), diff(mapOf(row.id to Mark(0)), listOf(failure.copy(state = "working")), now))
    }

    @Test fun limitedServerAttentionUsesCurrentResultBitsAndNotifiesNewBits() {
        for (kind in listOf(BIT_DONE, BIT_FAILED)) {
            val limited = row.copy(state = "idle", limitResetsAtMs = reset,
                completionAttention = kind == BIT_DONE, failedAttention = kind == BIT_FAILED)
            for (old in 0..3) {
                val baseline = mapOf(row.id to Mark(old))
                val expected = if (old and kind == 0) listOf(Event(limited, kind)) else emptyList()
                assertEquals(expected, diff(baseline, listOf(limited), now))
                val saved = update(baseline, listOf(limited), now)
                assertEquals(mapOf(row.id to Mark(kind)), saved)
                assertEquals(saved, update(saved, listOf(limited), reset - 1))
            }
        }
    }

    @Test fun firstRunSavesLimitedAttentionAndNewRowsNotifyAtOnceNotAtReset() {
        val limited = row.copy(completionAttention = true, limitResetsAtMs = reset)
        for (baseline in listOf(null, emptyMap(), mapOf("other" to Mark(BIT_FAILED)))) {
            val expected = if (baseline == null) emptyList() else listOf(Event(limited, BIT_DONE))
            assertEquals(expected, diff(baseline, listOf(limited), now))
            val saved = update(baseline, listOf(limited), now)
            assertEquals(BIT_DONE, saved.getValue(row.id).bits)
            assertEquals(emptyList<Event>(), diff(saved, listOf(limited.copy(limitResetsAtMs = 0)), reset))
        }
    }

    @Test fun inputCanClearAndRiseDuringTheLimitAndAtReset() {
        val limited = row.copy(completionAttention = true, limitResetsAtMs = reset)
        val initial = update(mapOf(row.id to Mark(BIT_FAILED)), listOf(limited), now)
        val input = limited.copy(questionAttention = true)
        assertEquals(listOf(Event(input, BIT_INPUT)), diff(initial, listOf(input), now))
        val waiting = update(initial, listOf(input), now)
        assertEquals(BIT_DONE or BIT_INPUT, waiting.getValue(row.id).bits)
        assertEquals(emptyList<Event>(), diff(waiting, listOf(input), now))
        val cleared = update(waiting, listOf(limited), now)
        assertEquals(BIT_DONE, cleared.getValue(row.id).bits)
        val atReset = input.copy(limitResetsAtMs = 0, questionAttention = false, actionRequired = true)
        assertEquals(listOf(Event(atReset, BIT_INPUT)), diff(cleared, listOf(atReset), reset))
        assertEquals(mapOf(row.id to Mark(BIT_DONE or BIT_INPUT)), update(cleared, listOf(atReset), reset))
    }

    @Test fun archivedLimitedRowsClearAllAttention() {
        val limited = row.copy(completionAttention = true, limitResetsAtMs = reset)
        val saved = update(mapOf(row.id to Mark(7)), listOf(limited), now)
        val archived = limited.copy(archived = true, failedAttention = true, actionRequired = true)
        assertEquals(emptyList<Event>(), diff(saved, listOf(archived), now))
        assertEquals(mapOf(row.id to Mark(0)), update(saved, listOf(archived), now))
        assertEquals(saved, update(saved, emptyList(), now))
    }

    @Test fun aLimitStopNotifiesFailedOnceAndTheResetNotifiesNothing() {
        val limited = row.copy(state = "idle", lastOutcome = "limit", failedAttention = true, unread = true,
            alert = true, limitResetsAtMs = reset)
        assertEquals(listOf(Event(limited, BIT_FAILED)), diff(mapOf(row.id to Mark(0)), listOf(limited), now))
        val saved = update(mapOf(row.id to Mark(0)), listOf(limited), now)
        assertEquals(mapOf(row.id to Mark(BIT_FAILED)), saved)
        assertEquals(emptyList<Event>(), diff(saved, listOf(limited), now + 1))
        assertEquals(emptyList<Event>(), diff(saved, listOf(limited.copy(limitResetsAtMs = 0)), reset))
    }

    @Test fun nativeAttentionAfterALimitStopIsFailed() {
        val native = row.copy(state = "idle", nativeAttention = true, lastOutcome = "limit")
        assertEquals(BIT_FAILED, bits(native))
        assertEquals(listOf(Event(native, BIT_FAILED)), diff(mapOf(row.id to Mark(0)), listOf(native), now))
    }

    @Test fun observedTaskAfterResetCanCompleteNormally() {
        val limited = row.copy(failedAttention = true, limitResetsAtMs = reset)
        val saved = update(mapOf(row.id to Mark(0)), listOf(limited), now)
        val working = row.copy(state = "working", workingSinceMs = reset + 1)
        assertEquals(emptyList<Event>(), diff(saved, listOf(working), reset + 1))
        val workingBaseline = update(saved, listOf(working), reset + 1)
        assertEquals(mapOf(row.id to Mark(0)), workingBaseline)
        val done = row.copy(completionAttention = true, completionAtMs = reset + 10_000)
        assertEquals(listOf(Event(done, BIT_DONE)), diff(workingBaseline, listOf(done), reset + 10_000))
    }

    @Test fun aCompletionBetweenTheResetAndTheNextPollNotifies() {
        val limited = row.copy(failedAttention = true, limitResetsAtMs = reset)
        val saved = update(mapOf(row.id to Mark(0)), listOf(limited), now)
        val done = row.copy(completionAttention = true, completionAtMs = reset + 10_000)
        assertEquals(listOf(Event(done, BIT_DONE)), diff(saved, listOf(done), reset + 15_000))
        assertEquals(mapOf(row.id to Mark(BIT_DONE, reset + 10_000)), update(saved, listOf(done), reset + 15_000))
    }

    @Test fun theBaselineUsesTheGlobalIdSoAnotherEngineDoesNotPostAgain() {
        // The same session on the paired PC and as a remote row of another engine has two row IDs and one key.
        val local = Thread(id = "codex:1", globalId = "aaaaaaaaaaaaaaaa:codex:1", completionAttention = true)
        val remote = local.copy(id = "m:aaaaaaaaaaaaaaaa:codex:1", remote = true)
        val seen = update(mapOf(local.key to Mark(0)), listOf(local), now)
        assertEquals(mapOf("aaaaaaaaaaaaaaaa:codex:1" to Mark(BIT_DONE)), seen)
        assertEquals(emptyList<Event>(), diff(seen, listOf(remote), now))
        assertEquals(seen, update(seen, listOf(remote), now))
        // An older PC sends no globalId: the key is the row ID.
        assertEquals(mapOf("old" to Mark(BIT_DONE)), update(null, listOf(Thread(id = "old", completionAttention = true)), now))
    }

    private val all = listOf(BIT_INPUT, BIT_FAILED, BIT_DONE)

    // The kinds that the cancel list names for the row "one". [engine] is the engine of the read ("" is the paired PC).
    private fun cancelled(baseline: Map<String, Mark>?, vararg rows: Thread, engine: String = "", nowMs: Long = now) =
        cleared(baseline, rows.toList(), engine, nowMs).filter { it.key == row.id }.map { it.kind }

    @Test fun aReadRowCancelsItsNotificationAndAnUnreadMarkDoesNot() {
        val done = row.copy(completionAttention = true)
        assertEquals(listOf(BIT_INPUT, BIT_FAILED), cancelled(update(null, listOf(done), now), done))
        assertEquals(all, cancelled(mapOf(row.id to Mark(BIT_DONE)), row))
    }

    @Test fun theCancelListDoesNotNeedABitChange() {
        // The open screen saves the cleared bit before the service reads: the old bit is already clear, and the cancel still comes.
        for (old in listOf(0, BIT_DONE, BIT_DONE or BIT_FAILED or BIT_INPUT)) {
            assertEquals(all, cancelled(mapOf(row.id to Mark(old)), row))
        }
        assertEquals(listOf(BIT_INPUT, BIT_FAILED), cancelled(emptyMap(), row.copy(completionAttention = true)))
    }

    @Test fun onlyTheClearedKindIsInTheCancelList() {
        val marked = row.copy(completionAttention = true, failedAttention = true)
        val baseline = update(null, listOf(marked.copy(actionRequired = true)), now)
        assertEquals(listOf(BIT_INPUT), cancelled(baseline, marked))
        assertEquals(listOf(BIT_FAILED), cancelled(baseline, marked.copy(failedAttention = false, actionRequired = true)))
    }

    @Test fun theCancelListUsesTheRowKey() {
        val local = Thread(id = "codex:1", globalId = "aaaaaaaaaaaaaaaa:codex:1")
        assertEquals(all.map { Cleared("aaaaaaaaaaaaaaaa:codex:1", it) }, cleared(mapOf(local.key to Mark(BIT_DONE)), listOf(local), "", now))
    }

    @Test fun readingALimitedRowCancelsItsFailedNotification() {
        val limited = row.copy(state = "idle", lastOutcome = "limit", failedAttention = true, limitResetsAtMs = reset)
        assertEquals(listOf(BIT_INPUT, BIT_DONE), cancelled(mapOf(row.id to Mark(BIT_FAILED)), limited))
        assertEquals(all, cancelled(mapOf(row.id to Mark(BIT_FAILED)), limited.copy(failedAttention = false)))
    }

    @Test fun aRowMissingFromTheUpdateKeepsItsNotifications() {
        val other = Thread(id = "other", actionRequired = true)
        val baseline = mapOf(row.id to Mark(BIT_DONE), other.id to Mark(BIT_INPUT))
        val list = cleared(baseline, listOf(other), "", now)
        assertEquals(listOf(Cleared(other.id, BIT_FAILED), Cleared(other.id, BIT_DONE)), list)
        assertEquals(emptyList<Cleared>(), cleared(baseline, emptyList(), "", now))
    }

    @Test fun anArchivedRowCancelsAllKinds() {
        val archived = row.copy(archived = true, completionAttention = true,
            failedAttention = true, questionAttention = true, actionRequired = true)
        assertEquals(all, cancelled(mapOf(row.id to Mark(7)), archived))
    }

    @Test fun aRemoteRowCancelsOnlyOnAReadOfThePairedPc() {
        val remote = row.copy(remote = true)
        val baseline = mapOf(row.id to Mark(BIT_DONE))
        // The paired PC marks its remote rows with its own tracker, so its clear bits are true.
        assertEquals(all, cancelled(baseline, remote))
        // Another engine starts a remote row that it sees for the first time with no mark, so its clear bits prove nothing.
        assertEquals(emptyList<Int>(), cancelled(baseline, remote, engine = "aaaaaaaaaaaaaaaa"))
        // A local row of that engine has the marks of that engine.
        assertEquals(all, cancelled(baseline, row, engine = "aaaaaaaaaaaaaaaa"))
    }

    @Test fun aFirstRunCancelsNothing() {
        assertEquals(emptyList<Cleared>(), cleared(null, listOf(row), "", now))
        assertEquals(emptyList<Cleared>(), cleared(null, listOf(row.copy(remote = true)), "aaaaaaaaaaaaaaaa", now))
    }
}
