package local.asb.companion

import local.asb.companion.data.Thread
import local.asb.companion.ui.Filter
import local.asb.companion.ui.PillCounts
import local.asb.companion.ui.STATES
import local.asb.companion.ui.activeFilterChips
import local.asb.companion.ui.backClears
import local.asb.companion.ui.filtersOn
import local.asb.companion.ui.homePath
import local.asb.companion.ui.lastUpdateText
import local.asb.companion.ui.OFFLINE_BAND_LIVE
import local.asb.companion.ui.offlineBandAge
import local.asb.companion.ui.pathMatch
import local.asb.companion.ui.pendingHeader
import local.asb.companion.ui.pillCounts
import local.asb.companion.ui.pillDescription
import local.asb.companion.ui.pillLabel
import local.asb.companion.ui.removeFilter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Android council round 1, list issues 1, 2, 3, 7, and 14 (made-up rows). */
class AndroidCouncilRoundOneListTest {
    private val now = 1_800_000_000_000L
    private val idle = Thread(state = "idle", updatedAtMs = now)
    private val rows = listOf(
        idle.copy(id = "pin", title = "release notes", pinned = true, pending = true, unread = true),
        idle.copy(id = "q", title = "fix flaky upload test", pending = true, questionAttention = true, state = "waiting"),
        idle.copy(id = "dot", title = "add dark mode tokens", pending = true, unread = true),
        idle.copy(id = "w1", title = "port the sync client", state = "working", workingSinceMs = now),
        idle.copy(id = "w2", title = "load test the gateway", state = "working", workingSinceMs = now, provider = "codex"),
        idle.copy(id = "d", title = "rename the store keys", drawer = true, unread = true),
        idle.copy(id = "a", title = "old drawer row", drawer = true, archived = true),
    )

    @Test fun pillCountsIgnoreTheSearchAndTheOtherFilters() {
        val expected = PillCounts(pending = 3, working = 2, drawer = 1)
        assertEquals(expected, pillCounts(rows, Filter()))
        // The search, the pills, and the app filter do not change a count; Include archived does.
        assertEquals(expected, pillCounts(rows, Filter(query = "nothing matches this")))
        assertEquals(expected, pillCounts(rows, Filter(pendingOnly = true)))
        assertEquals(expected, pillCounts(rows, Filter(app = "codex")))
        assertEquals(2, pillCounts(rows, Filter(archived = true)).drawer)
        assertEquals("Pending 12", pillLabel("Pending", 12))
        assertEquals("Drawer", pillLabel("Drawer", 0))
        assertEquals("Pending, 4 sessions", pillDescription("Pending", 4))
        assertEquals("Working, 1 session", pillDescription("Working", 1))
        assertEquals("Drawer, 0 sessions", pillDescription("Drawer", 0))
    }

    @Test fun thePendingHeaderLeadsTheFirstPendingRowAfterThePins() {
        val sorted = local.asb.companion.ui.filteredRows(rows, Filter())
        assertEquals("pin", sorted[0].id)
        assertEquals(listOf(1), sorted.indices.filter { pendingHeader(sorted, it) })
        // No pins: the header is at the top.
        val unpinned = sorted.filter { !it.pinned }
        assertEquals(listOf(0), unpinned.indices.filter { pendingHeader(unpinned, it) })
    }

    @Test fun filterChipsFollowTheBoardAndRemoveOneFilterEach() {
        assertFalse(filtersOn(Filter(query = "atlas")))
        assertEquals(emptyList<Pair<String, String>>(), activeFilterChips(Filter(query = "atlas")))
        val all = Filter(pendingOnly = true, states = setOf("working", "idle"), app = "claude-desktop-code", archived = true)
        assertTrue(filtersOn(all))
        assertEquals(
            listOf("state:working" to "Working", "state:idle" to "Idle", "app" to "Claude",
                "archive" to "Include archived"),
            activeFilterChips(all),
        )
        assertEquals(emptyList<Pair<String, String>>(), activeFilterChips(Filter(drawerOnly = true)))
        assertEquals(all.copy(pendingOnly = false), removeFilter(all, "pending"))
        assertEquals(all.copy(states = setOf("idle")), removeFilter(all, "state:working"))
        // The last state chip shows all states again.
        assertEquals(Filter(), removeFilter(Filter(states = setOf("working")), "state:working"))
        assertEquals(STATES.toSet(), removeFilter(Filter(states = setOf("idle")), "state:idle").states)
        assertEquals(all.copy(app = "all"), removeFilter(all, "app"))
        assertEquals(all.copy(archived = false), removeFilter(all, "archive"))
        assertEquals(Filter(), removeFilter(Filter(drawerOnly = true), "drawer"))
    }

    @Test fun backClearsSearchAndFiltersBeforeItLeaves() {
        assertFalse(backClears(searching = false, Filter()))
        assertTrue(backClears(searching = true, Filter()))
        // Search closed, a filter on: Back clears it first.
        assertTrue(backClears(searching = false, Filter(pendingOnly = true)))
        assertTrue(backClears(searching = false, Filter(states = setOf("working"))))
        // Column Flow keeps its field open; a query alone also counts.
        assertTrue(backClears(searching = false, Filter(query = "atlas")))
    }

    @Test fun aRowThatMatchesOnlyByItsPathShowsThePath() {
        val row = idle.copy(title = "fix flaky upload test", projectName = "uploader", cwd = "/home/dev/work/clients/acme/uploader",
            providerLabel = "Codex")
        assertEquals("~/work/clients/acme/uploader", pathMatch(row, "acme"))
        assertEquals("~/work/clients/acme/uploader", pathMatch(row, "cx: ACME"))
        // A match in the shown text, or no query, keeps the project name.
        assertEquals("", pathMatch(row, "upload"))
        assertEquals("", pathMatch(row, ""))
        assertEquals("", pathMatch(row, "zzz"))
        assertEquals("", pathMatch(row.copy(cwd = ""), "acme"))
        assertEquals("~", homePath("/home/dev"))
        assertEquals("~/src", homePath("/Users/dev/src"))
        assertEquals("~\\src", homePath("C:\\Users\\dev\\src"))
        assertEquals("/srv/home/dev", homePath("/srv/home/dev"))
    }

    @Test fun theOfflineBandSaysTheAgeOfTheSavedList() {
        assertEquals("", offlineBandAge(0, now))
        assertEquals("", lastUpdateText(0, now))
        assertEquals("last update just now", offlineBandAge(now - 20_000, now))
        assertEquals("last update 12m ago", offlineBandAge(now - 12 * 60_000, now))
        assertEquals("last update 2h ago", offlineBandAge(now - 2 * 3_600_000, now))
        assertEquals("Last update 12m ago", lastUpdateText(now - 12 * 60_000, now))
        // The live region text has no age, so TalkBack does not read the band again when only the age changes.
        assertEquals("Offline. No alerts until the PC answers.", OFFLINE_BAND_LIVE)
        assertFalse(Regex("\\d|ago|now|update").containsMatchIn(OFFLINE_BAND_LIVE))
    }
}
