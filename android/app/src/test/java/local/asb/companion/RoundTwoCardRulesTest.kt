package local.asb.companion

import local.asb.companion.data.Palette
import local.asb.companion.data.Thread
import local.asb.companion.ui.CompactMarkStyle
import local.asb.companion.ui.Filter
import local.asb.companion.ui.cardTones
import local.asb.companion.ui.compactMarkStyle
import local.asb.companion.ui.compactStateText
import local.asb.companion.ui.filteredRows
import local.asb.companion.ui.hexColor
import local.asb.companion.ui.providerMarkTint
import local.asb.companion.ui.quietRow
import local.asb.companion.ui.rowMenuActions
import local.asb.companion.ui.rowPanelControls
import local.asb.companion.ui.workingDuration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RoundTwoCardRulesTest {
    private val now = 1_800_000_000_000L
    private val palette = Palette()
    private val custom = palette.copy(mode = "custom")
    private val idle = Thread(state = "idle", updatedAtMs = now)

    @Test fun pendingSortsByVisibleMarkThenMomentAndId() {
        val rows = listOf(
            idle.copy(id = "none", pending = true, state = "working", workingSinceMs = now),
            idle.copy(id = "dot", pending = true, unread = true),
            idle.copy(id = "alert", pending = true, alert = true, state = "working", workingSinceMs = now),
            idle.copy(id = "question-old", pending = true, questionAttention = true, updatedAtMs = now - 1),
            idle.copy(id = "question-b", pending = true, actionRequired = true),
            idle.copy(id = "question-a", pending = true, questionAttention = true),
            idle.copy(id = "working-question", pending = true, questionAttention = true, state = "working", workingSinceMs = 1),
        )
        val expected = listOf("working-question", "question-a", "question-b", "question-old", "alert", "dot", "none")
        assertEquals(expected, filteredRows(rows, Filter()).map { it.id })
        val pinsAndBuckets = listOf(
            idle.copy(id = "unknown", state = "unknown"), idle.copy(id = "idle"),
            idle.copy(id = "working", state = "working", workingSinceMs = 1),
            rows[0].copy(id = "pin-b", pinned = true, pinIndex = 1),
            rows.last().copy(id = "pin-a", pinned = true, pinIndex = 0),
        )
        assertEquals(listOf("pin-a", "pin-b") + expected + listOf("working", "idle", "unknown"),
            filteredRows(rows + pinsAndBuckets, Filter()).map { it.id })
        val tiedPins = listOf(rows.first().copy(id = "a", pinned = true), rows.last().copy(id = "b", pinned = true))
        assertEquals(listOf("a", "b"), filteredRows(tiedPins, Filter()).map { it.id })
    }

    @Test fun pendingSortUsesTheDrawerViewMark() {
        val rows = listOf(idle.copy(id = "drawer", pending = true, drawer = true, updatedAtMs = now - 1),
            idle.copy(id = "empty", pending = true, drawer = true, state = "working", workingSinceMs = now))
        assertEquals(listOf("empty", "drawer"), filteredRows(rows, Filter()).map { it.id })
        assertEquals(listOf("drawer", "empty"), filteredRows(rows, Filter(drawerOnly = true)).map { it.id })
    }

    @Test fun drawerActionsFollowPinAndPrecedePinMoves() {
        assertEquals(listOf("mark-read", "pin", "drawer-in"), rowMenuActions(idle.copy(unread = true)).map { it.action })
        assertEquals(listOf("mark-read", "unpin", "drawer-out", "pin-up", "pin-down", "discard-result"),
            rowMenuActions(idle.copy(state = "working", drawer = true, pinned = true)).map { it.action })
        assertEquals(listOf("unread", "pinned", "drawer", "order", "discard"),
            rowPanelControls(idle.copy(state = "working", pinned = true)).keys.toList())
    }

    @Test fun compactActiveMarksUseTwelveDpAccentDiscs() {
        for (row in listOf(idle.copy(questionAttention = true), idle.copy(alert = true),
            idle.copy(state = "waiting", actionRequired = true),
            idle.copy(state = "waiting", actionRequired = true, actionAttention = false, unread = true))) {
            assertEquals(CompactMarkStyle(12, 9, palette.background), compactMarkStyle(row, palette, false, now))
        }
    }

    @Test fun compactReadPermissionUsesABareQuietQuestion() {
        val row = idle.copy(state = "waiting", actionRequired = true, actionAttention = false)
        assertEquals(CompactMarkStyle(0, 11, palette.quietCaption), compactMarkStyle(row, palette, false, now))
    }

    @Test fun compactWorkingUsesWholeMinutesButOtherViewsKeepSeconds() {
        for ((seconds, compact, full) in listOf(
            Triple(45L, "45s", "45s"), Triple(60L, "1m", "1m00s"), Triple(191L, "3m", "3m11s"),
            Triple(2820L, "47m", "47m00s"), Triple(3900L, "1h05m", "1h05m"),
        )) {
            val start = now - seconds * 1000
            assertEquals("Working · $compact", compactStateText(idle.copy(state = "working", workingSinceMs = start), now))
            assertEquals(full, workingDuration(start, now))
        }
        assertEquals("Working", compactStateText(idle.copy(state = "working"), now))
        assertEquals("Working", compactStateText(idle.copy(state = "working", workingSinceMs = now + 1), now))
        assertEquals("Idle", compactStateText(idle, now))
    }

    @Test fun compactUsageLimitSaysResetsIn() {
        assertEquals("Resets in 4h31m", compactStateText(idle.copy(limitResetsAtMs = now + (4 * 3600 + 31 * 60) * 1000L), now))
        assertEquals("Resets in 3d04h", compactStateText(idle.copy(limitResetsAtMs = now + (3 * 24 + 4) * 3600_000L), now))
        assertEquals("Stopped", compactStateText(idle.copy(lastOutcome = "limit", limitResetsAtMs = now), now))
    }

    @Test fun quietProviderMarksAreOpaqueButLimitAndMessageLightWin() {
        assertEquals(hexColor(palette.quietCaption), providerMarkTint(palette, false, false, quiet = true))
        assertEquals(hexColor(palette.text).copy(alpha = .65f), providerMarkTint(palette, false, false))
        assertEquals(hexColor(palette.text).copy(alpha = .4f), providerMarkTint(palette, true, false, quiet = true))
        assertEquals(hexColor(palette.accent), providerMarkTint(palette, true, true, quiet = true))
        for (pressed in listOf(false, true)) {
            val tones = cardTones(palette, idle, true, false, pressed, now)
            assertEquals(if (pressed) hexColor(palette.text).copy(alpha = .65f) else hexColor(palette.quietCaption),
                providerMarkTint(palette, false, false, quiet = tones.caption == palette.quietCaption))
        }
    }

    @Test fun pendingStateUsesTextInEveryPaletteAndView() {
        for (p in listOf(palette, custom)) for (comfortable in listOf(false, true)) for (pressed in listOf(false, true)) {
            for (state in listOf("idle", "waiting", "unknown")) {
                assertEquals(p.text, cardTones(p, idle.copy(state = state, pending = true, unread = true), comfortable, false, pressed, now).state)
            }
            assertEquals(p.success, cardTones(p, idle.copy(state = "working", pending = true, questionAttention = true), comfortable, false, pressed, now).state)
        }
    }

    @Test fun unknownWithoutAMarkUsesQuietIdleTonesAndRestoresOnPress() {
        val unknown = idle.copy(state = "unknown")
        for (p in listOf(palette, custom)) {
            assertTrue(quietRow(unknown, true, false, now))
            assertEquals(cardTones(p, idle, true, false, false, now), cardTones(p, unknown, true, false, false, now))
            assertEquals(cardTones(p, idle, true, false, true, now), cardTones(p, unknown, true, false, true, now))
        }
        for (marked in listOf(unknown.copy(alert = true), unknown.copy(unread = true), unknown.copy(questionAttention = true),
            unknown.copy(actionRequired = true), unknown.copy(pending = true), unknown.copy(limitResetsAtMs = now + 1))) {
            assertFalse(quietRow(marked, true, false, now))
        }
        assertFalse(quietRow(unknown, false, false, now))
        assertFalse(quietRow(unknown.copy(drawer = true), true, true, now))
        assertTrue(quietRow(unknown.copy(drawer = true), true, false, now))
    }
}
