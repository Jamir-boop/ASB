package local.asb.companion

import local.asb.companion.data.Thread
import local.asb.companion.notify.liveIntervalMs
import local.asb.companion.notify.liveLines
import local.asb.companion.notify.liveOfflineText
import local.asb.companion.notify.liveTitle
import org.junit.Assert.assertEquals
import org.junit.Test

class LiveNotificationTest {
    private val now = 1_800_000_000_000L

    private fun row(id: String, state: String = "idle", pending: Boolean = false, archived: Boolean = false, title: String = "Task $id") =
        Thread(id = id, state = state, pending = pending, archived = archived, title = title)

    @Test fun titleCountsUnarchivedRowsWithTheCorrectNoun() {
        assertEquals("0 sessions · 0 working · 0 pending", liveTitle(emptyList()))
        assertEquals("1 session · 1 working · 1 pending", liveTitle(listOf(row("a", "working", pending = true))))
        assertEquals("2 sessions · 1 working · 1 pending", liveTitle(listOf(
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
    }

    @Test fun offlineTextUsesTheIdleAge() {
        assertEquals("Offline", liveOfflineText(0, now))
        assertEquals("Offline · last update just now", liveOfflineText(now - 30_000, now))
        assertEquals("Offline · last update 5m ago", liveOfflineText(now - 300_000, now))
        assertEquals("Offline · last update 2h ago", liveOfflineText(now - 7_200_000, now))
    }
}
