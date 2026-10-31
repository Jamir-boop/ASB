package local.asb.companion

import local.asb.companion.data.Thread
import local.asb.companion.notify.LiveBadge
import local.asb.companion.notify.LiveChip
import local.asb.companion.notify.LiveUpdate
import local.asb.companion.notify.liveBadge
import local.asb.companion.notify.liveIntervalMs
import local.asb.companion.notify.liveLines
import local.asb.companion.notify.liveOfflineText
import local.asb.companion.notify.liveTitle
import local.asb.companion.notify.newlyDone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveNotificationTest {
    private val now = 1_800_000_000_000L

    private fun row(id: String, state: String = "idle", pending: Boolean = false, archived: Boolean = false, title: String = "Task $id") =
        Thread(id = id, state = state, pending = pending, archived = archived, title = title)

    @Test fun titleCountsUnarchivedRowsWithTheCorrectNoun() {
        assertEquals("0 pending · 0 working · 0 sessions", liveTitle(emptyList()))
        assertEquals("1 pending · 1 working · 1 session", liveTitle(listOf(row("a", "working", pending = true))))
        assertEquals("1 pending · 1 working · 2 sessions", liveTitle(listOf(
            row("a", "working"), row("b", pending = true),
            row("c", "working", pending = true, archived = true),
        )))
    }

    @Test fun linesListWorkingTitlesThenTheRest() {
        assertEquals(listOf("No session is working."), liveLines(listOf(row("a"), row("b", "working", archived = true))))
        assertEquals(listOf("Task a", "proj", "Untitled session"), liveLines(listOf(
            row("a", "working"), Thread(id = "b", state = "working", projectName = "proj"),
            Thread(id = "c", state = "working"), row("d", "waiting"),
        )))
        val many = (1..8).map { row("$it", "working") }
        assertEquals((1..6).map { "Task $it" } + "+2 more", liveLines(many))
        assertEquals((1..6).map { "Task $it" }, liveLines(many.take(6)))
    }

    @Test fun intervalIsShortOnlyWhileAnUnarchivedSessionWorks() {
        assertEquals(5_000L, liveIntervalMs(listOf(row("a", "working")), offline = false))
        assertEquals(30_000L, liveIntervalMs(listOf(row("a", "working", archived = true), row("b")), offline = false))
        assertEquals(30_000L, liveIntervalMs(null, offline = false))
        assertEquals(30_000L, liveIntervalMs(listOf(row("a", "working")), offline = true))
        // One quick retry after a network change, for a VPN that needs a few seconds.
        assertEquals(3_000L, liveIntervalMs(null, offline = true, afterNetworkChange = true))
        assertEquals(5_000L, liveIntervalMs(listOf(row("a", "working")), offline = false, afterNetworkChange = true))
    }

    @Test fun offlineTextUsesTheIdleAge() {
        assertEquals("Offline", liveOfflineText(0, now))
        assertEquals("Offline · last update just now", liveOfflineText(now - 30_000, now))
        assertEquals("Offline · last update 5m ago", liveOfflineText(now - 300_000, now))
        assertEquals("Offline · last update 2h ago", liveOfflineText(now - 7_200_000, now))
    }

    @Test fun badgeShowsDoneFirstThenThePendingCountThenTheWorkingCount() {
        // The Done flash wins over the pending rows.
        assertEquals(LiveBadge(LiveChip.DONE, "Done"), liveBadge(listOf(row("a", pending = true)), doneFlash = true))
        // One pending row asks a question, so the chip shows the input icon with the pending count.
        assertEquals(LiveBadge(LiveChip.INPUT, "2"), liveBadge(listOf(
            row("a", pending = true).copy(questionAttention = true), row("b", pending = true),
        ), doneFlash = false))
        // A pending row with only a result shows the pending icon, and pending wins over working.
        assertEquals(LiveBadge(LiveChip.PENDING, "1"), liveBadge(listOf(
            row("a", pending = true).copy(completionAttention = true), row("b", "working"),
        ), doneFlash = false))
        // Without a pending row the chip counts the unarchived working rows.
        assertEquals(LiveBadge(LiveChip.WORKING, "2"), liveBadge(listOf(
            row("a", "working"), row("b", "working"), row("c", "working", archived = true),
        ), doneFlash = false))
        assertNull(liveBadge(listOf(row("a"), row("b", "waiting")), doneFlash = false))
        assertNull(liveBadge(emptyList(), doneFlash = false))
    }

    @Test fun badgeIgnoresArchivedRows() {
        val archived = row("a", "working", pending = true, archived = true).copy(questionAttention = true)
        assertNull(liveBadge(listOf(archived), doneFlash = false))
        assertEquals(LiveBadge(LiveChip.WORKING, "1"), liveBadge(listOf(archived, row("b", "working")), doneFlash = false))
    }

    @Test fun newlyDoneNeedsAResultThatThePreviousListDidNotHave() {
        val done = row("a").copy(completionAttention = true)
        // The first update has nothing to compare with.
        assertFalse(newlyDone(null, LiveUpdate(listOf(done), now, "")))
        assertTrue(newlyDone(LiveUpdate(listOf(row("a")), now, ""), LiveUpdate(listOf(done), now, "")))
        // A result that was already there is not new.
        assertFalse(newlyDone(LiveUpdate(listOf(done), now, ""), LiveUpdate(listOf(done), now, "")))
        // A row that is new in the list is not a new result.
        assertFalse(newlyDone(LiveUpdate(listOf(row("b")), now, ""), LiveUpdate(listOf(done), now, "")))
        // A done row that became archived has no Done mark any more.
        assertFalse(newlyDone(LiveUpdate(listOf(done), now, ""), LiveUpdate(listOf(done.copy(archived = true)), now, "")))
    }

    @Test fun newlyDoneSkipsAUsageLimitStop() {
        // A usage-limit stop ends the turn as a result, but diff() posts no Done for it.
        val limited = row("a", "idle").copy(completionAttention = true, limitResetsAtMs = now + 3_600_000)
        assertFalse(newlyDone(LiveUpdate(listOf(row("a", "working")), now, ""), LiveUpdate(listOf(limited), now, "")))
    }

    @Test fun newlyDoneSkipsTheFirstResultAfterALimitReset() {
        // diff() also posts no Done for the first return of the mark after the reset.
        val limited = row("a").copy(completionAttention = false, limitResetsAtMs = now + 1_000)
        assertFalse(newlyDone(LiveUpdate(listOf(limited), now, ""),
            LiveUpdate(listOf(limited.copy(completionAttention = true)), now + 2_000, "")))
    }

    @Test fun newlyDoneSkipsAChangeOfEngine() {
        // The read marks are per engine: a row that the new engine has unread is not a new result.
        val done = listOf(row("a").copy(completionAttention = true))
        assertFalse(newlyDone(LiveUpdate(listOf(row("a")), now, ""), LiveUpdate(done, now, "m1")))
        assertTrue(newlyDone(LiveUpdate(listOf(row("a")), now, "m1"), LiveUpdate(done, now, "m1")))
    }

    @Test fun newlyDoneCountsANewerCompletionOfADoneRow() {
        val done = row("a").copy(completionAttention = true, completionAtMs = 100)
        assertTrue(newlyDone(LiveUpdate(listOf(done), now, ""), LiveUpdate(listOf(done.copy(completionAtMs = 200)), now, "")))
        assertFalse(newlyDone(LiveUpdate(listOf(done), now, ""), LiveUpdate(listOf(done), now, "")))
    }
}
