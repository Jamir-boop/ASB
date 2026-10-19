package local.asb.companion

import local.asb.companion.R
import local.asb.companion.data.Palette
import local.asb.companion.data.Thread
import local.asb.companion.ui.CardTones
import local.asb.companion.ui.CornerControl
import local.asb.companion.ui.cardTones
import local.asb.companion.ui.cornerControls
import local.asb.companion.ui.isViewOnly
import local.asb.companion.ui.COMFORTABLE_CARD_GAP
import local.asb.companion.ui.COMFORTABLE_MIN_CARD_GAP
import local.asb.companion.ui.comfortableCardHeight
import local.asb.companion.ui.compactRowHeight
import local.asb.companion.ui.packColumns
import local.asb.companion.ui.quietRow
import local.asb.companion.ui.rowMenuActions
import local.asb.companion.ui.rowWhere
import local.asb.companion.ui.viewOnlyTone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CardRulesTest {
    private val now = 1_800_000_000_000L
    private val gnome = Palette()
    private val custom = Palette("custom", "#101418", "#e8e4dc", "#f0b45a", "#a8a29a", "#3a3f46", "#f0b45a", "#f0b45a")
    private val idle = Thread(id = "a", state = "idle", updatedAtMs = now - 60_000)
    private val limited = idle.copy(limitResetsAtMs = now + 60_000)

    @Test fun stateToneFollowsUpdateSessionRow() {
        fun state(row: Thread, palette: Palette = gnome) = cardTones(palette, row, false, false, false, now).state
        assertEquals(gnome.success, state(idle.copy(state = "working")))
        assertEquals(gnome.warning, state(idle.copy(state = "waiting")))
        assertEquals(gnome.muted, state(idle))
        assertEquals(gnome.muted, state(idle.copy(state = "unknown")))
        // GNOME Pending drops dim-label; Custom keeps the muted state color.
        assertEquals(gnome.text, state(idle.copy(pending = true, unread = true)))
        assertEquals(custom.muted, state(idle.copy(pending = true, unread = true), custom))
        assertEquals(custom.accent, state(idle.copy(state = "working"), custom))
    }

    @Test fun quietRuleIsComfortableIdleReadOnly() {
        assertTrue(quietRow(idle, comfortable = true, drawerView = false, nowMs = now))
        assertTrue(quietRow(idle.copy(pinned = true), comfortable = true, drawerView = false, nowMs = now))
        assertFalse(quietRow(idle, comfortable = false, drawerView = false, nowMs = now))
        for (row in listOf(idle.copy(unread = true), idle.copy(questionAttention = true), idle.copy(pending = true),
            idle.copy(state = "waiting"), idle.copy(state = "working"), limited)) {
            assertFalse(row.toString(), quietRow(row, comfortable = true, drawerView = false, nowMs = now))
        }
        // A drawer row is quiet as a read row, but not while the Drawer pill shows it as unread.
        assertTrue(quietRow(idle.copy(drawer = true), comfortable = true, drawerView = false, nowMs = now))
        assertFalse(quietRow(idle.copy(drawer = true), comfortable = true, drawerView = true, nowMs = now))

        assertEquals(CardTones(gnome.quietTitle, gnome.quietCaption, gnome.quietCaption),
            cardTones(gnome, idle, true, false, false, now))
        assertEquals(CardTones(custom.quietTitle, custom.quietCaption, custom.quietCaption),
            cardTones(custom, idle, true, false, false, now))
        // Pressed returns to the normal roles.
        assertEquals(CardTones(gnome.text, gnome.muted, gnome.muted), cardTones(gnome, idle, true, false, true, now))
    }

    @Test fun limitedRowsUseTheLimitedColorEverywhere() {
        assertEquals(CardTones(gnome.limited, gnome.limited, gnome.limited), cardTones(gnome, limited, true, false, false, now))
        assertEquals(CardTones(gnome.limitedPressed, gnome.limitedPressed, gnome.limitedPressed),
            cardTones(gnome, limited, false, false, true, now))
        assertEquals(CardTones(custom.limited, custom.limited, custom.limited),
            cardTones(custom, limited.copy(state = "working"), false, false, false, now))
        // At the reset the row shows its normal text again.
        assertEquals(CardTones(gnome.text, gnome.muted, gnome.muted),
            cardTones(gnome, limited, false, false, false, limited.limitResetsAtMs))
    }

    @Test fun cornerShowsWhatTheDesktopShowsWithoutHover() {
        fun kinds(row: Thread, drawerView: Boolean = false, confirmed: Boolean = false) =
            cornerControls(row, drawerView, confirmed, now).map { it.kind to it.action }
        assertEquals(emptyList<Pair<String, String?>>(), kinds(idle))
        assertEquals(listOf("dot" to "mark-read"), kinds(idle.copy(unread = true)))
        assertEquals(listOf("question" to "mark-read"), kinds(idle.copy(questionAttention = true)))
        assertEquals(listOf("question" to null), kinds(idle.copy(state = "waiting", actionRequired = true)))
        assertEquals(listOf("stop" to null), kinds(idle.copy(lastOutcome = "stopped")))
        assertEquals(listOf("pin" to "unpin"), kinds(idle.copy(pinned = true)))
        assertEquals(listOf("dot" to "mark-read", "pin" to "unpin"), kinds(idle.copy(unread = true, pinned = true)))
        // The armed Discard ring shows; the unarmed offer stays in the menu.
        assertEquals(listOf("discard" to "keep-result"), kinds(idle.copy(state = "working", discardResult = true)))
        assertEquals(emptyList<Pair<String, String?>>(), kinds(idle.copy(state = "working")))
        assertEquals(listOf("question" to "mark-read"),
            kinds(idle.copy(state = "working", discardResult = true, questionAttention = true)))
        // A drawer row looks read outside the Drawer view, and shows its Read target inside it.
        val tucked = idle.copy(drawer = true, pinned = true)
        assertEquals(listOf("drawer" to "drawer-out", "pin" to "unpin"), kinds(tucked))
        assertEquals(listOf("drawer" to "drawer-out", "dot" to "mark-read", "pin" to "unpin"), kinds(tucked, drawerView = true))
        // The check replaces the slot for 1.6 s, but never on a Working row without a question.
        assertEquals(listOf("confirmed" to null), kinds(idle, confirmed = true))
        assertEquals(emptyList<Pair<String, String?>>(), kinds(idle.copy(state = "working"), confirmed = true))
        assertEquals(CornerControl("pin", "unpin", "Unpin in ASB"), cornerControls(idle.copy(pinned = true), false, false, now).single())
    }

    @Test fun columnFlowPackingMatchesPythonPackColumns() {
        fun pack(count: Int, width: Int, height: Int, rowHeight: Float) =
            packColumns((0 until count).toList(), width, height, rowHeight = rowHeight).let { (columns, capacity, parts) ->
                Triple(columns, capacity, parts.map { it.size })
            }
        assertEquals(Triple(1, 8, listOf(8, 2)), pack(10, 360, 600, 68f))
        assertEquals(Triple(2, 4, listOf(4, 4, 2)), pack(10, 680, 300, 68f))
        assertEquals(Triple(4, 5, listOf(5, 5, 5, 5, 5)), pack(25, 1040, 248, 48f))
        assertEquals(Triple(1, 1, listOf(1, 1, 1)), pack(3, 100, 2, 22f))
        assertEquals(Triple(3, 8, emptyList<Int>()), pack(0, 800, 400, 48f))
        assertEquals(Triple(4, 3, listOf(3, 3, 1)), pack(7, 1080, 248, 68f))
        assertEquals(listOf(listOf(0, 1, 2), listOf(3, 4, 5), listOf(6)), packColumns((0 until 7).toList(), 1080, 248, rowHeight = 68f).parts)
    }

    @Test fun comfortableCardHeightGrowsWithTheText() {
        assertEquals(68f, comfortableCardHeight(1f), .001f)
        // The provider mark and the clock keep the small lines from going below their icons.
        assertEquals(8f + 14f + 2 * 16f * .85f + 12f, comfortableCardHeight(.85f), .001f)
        assertEquals(8f + 60f * 1.3f, comfortableCardHeight(1.3f), .001f)
        assertEquals(48f, compactRowHeight(1.3f), .001f)
        assertEquals(64f, compactRowHeight(4f), .001f)
    }

    @Test fun columnFlowFitsWholeComfortableCardsWithTheirGaps() {
        for (scale in listOf(.85f, 1f, 1.15f, 1.3f, 2f)) for (height in listOf(300, 343, 372, 600)) {
            val card = comfortableCardHeight(scale)
            val packing = packColumns((0 until 40).toList(), 800, height, rowHeight = card,
                minGap = COMFORTABLE_MIN_CARD_GAP.toFloat(), maxGap = COMFORTABLE_CARD_GAP.toFloat())
            val used = packing.capacity * card + (packing.capacity - 1) * packing.gap
            assertTrue("scale $scale height $height", packing.capacity >= 1 && used <= height - 4 + .001f)
            assertTrue("scale $scale height $height", packing.gap <= COMFORTABLE_CARD_GAP)
            if (packing.capacity > 1) assertTrue(packing.gap >= COMFORTABLE_MIN_CARD_GAP - .001f)
            // One more card with the minimum gap does not fit.
            assertTrue((packing.capacity + 1) * card + packing.capacity * COMFORTABLE_MIN_CARD_GAP > height - 4)
        }
        val landscape = packColumns((0 until 40).toList(), 800, 343, rowHeight = comfortableCardHeight(1f),
            minGap = COMFORTABLE_MIN_CARD_GAP.toFloat(), maxGap = COMFORTABLE_CARD_GAP.toFloat())
        assertEquals(4, landscape.capacity)
        assertEquals((339f - 4 * 68f) / 3, landscape.gap, .001f)
        // Compact keeps no gap.
        assertEquals(0f, packColumns((0 until 40).toList(), 800, 343, rowHeight = 48f).gap, .001f)
    }

    private val remote = idle.copy(remote = true, machineName = "homeLP")
    private val cli = idle.copy(surface = "cli")

    @Test fun viewOnlyRowsSayWhereTheyRun() {
        assertTrue(isViewOnly(remote))
        assertTrue(isViewOnly(cli))
        assertFalse(isViewOnly(idle))
        assertEquals(R.drawable.ic_machine to "homeLP", rowWhere(remote))
        assertEquals(R.drawable.ic_terminal to "CLI", rowWhere(cli))
        // A remote CLI row names its machine.
        assertEquals(R.drawable.ic_machine to "homeLP", rowWhere(remote.copy(surface = "cli")))
        assertEquals(R.drawable.ic_machine to "another machine", rowWhere(remote.copy(machineName = "")))
        assertEquals(null to "", rowWhere(idle))
    }

    @Test fun viewOnlyToneIsQuietWithNoAttention() {
        assertEquals("", viewOnlyTone(idle))
        assertEquals("rest", viewOnlyTone(remote))
        assertEquals("rest", viewOnlyTone(cli.copy(state = "unknown")))
        for (state in listOf("working", "waiting")) assertEquals("quiet", viewOnlyTone(remote.copy(state = state)))
        for (row in listOf(remote.copy(unread = true), remote.copy(questionAttention = true), remote.copy(pending = true),
            remote.copy(limitResetsAtMs = now + 60_000))) assertEquals(row.toString(), "", viewOnlyTone(row))
    }

    @Test fun viewOnlyCardsUseTheQuietColorsAndTheLimitWins() {
        val working = remote.copy(state = "working")
        // In both views; a Working row keeps its state color.
        for (comfortable in listOf(true, false)) {
            assertEquals(CardTones(gnome.quietTitle, gnome.quietCaption, gnome.success), cardTones(gnome, working, comfortable, false, false, now))
            assertEquals(CardTones(gnome.quietTitle, gnome.quietCaption, gnome.quietCaption), cardTones(gnome, remote, comfortable, false, false, now))
        }
        assertEquals(CardTones(custom.quietTitle, custom.quietCaption, custom.warning),
            cardTones(custom, cli.copy(state = "waiting"), false, false, false, now))
        assertEquals(CardTones(gnome.limited, gnome.limited, gnome.limited),
            cardTones(gnome, working.copy(limitResetsAtMs = now + 60_000), false, false, false, now))
        // Pressed and the drawer view of a drawer row keep the normal roles.
        assertEquals(CardTones(gnome.text, gnome.muted, gnome.success), cardTones(gnome, working, false, false, true, now))
        assertEquals(CardTones(gnome.text, gnome.muted, gnome.success), cardTones(gnome, working.copy(drawer = true), false, true, false, now))
        // Attention keeps full strength.
        assertEquals(CardTones(gnome.text, gnome.muted, gnome.muted), cardTones(gnome, remote.copy(unread = true), false, false, false, now))
    }

    @Test fun aRemoteWorkingRowHasNoDiscard() {
        val actions = rowMenuActions(remote.copy(state = "working")).map { it.action }
        assertFalse("discard-result" in actions)
        assertTrue("discard-result" in rowMenuActions(idle.copy(state = "working")).map { it.action })
        assertTrue("discard-result" in rowMenuActions(cli.copy(state = "working")).map { it.action })
    }
}
