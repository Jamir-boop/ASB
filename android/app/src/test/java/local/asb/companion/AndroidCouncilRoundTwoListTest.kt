package local.asb.companion

import java.time.ZoneOffset
import local.asb.companion.data.Thread
import local.asb.companion.ui.CORNER_TARGET
import local.asb.companion.ui.Filter
import local.asb.companion.ui.MUTE_CHOICES
import local.asb.companion.ui.WORKING_PULSE_MS
import local.asb.companion.ui.WORKING_PULSE_STEPS
import local.asb.companion.ui.WORKING_PULSE_STEP_MS
import local.asb.companion.ui.cornerControls
import local.asb.companion.ui.cornerSlotEnd
import local.asb.companion.ui.cornerSlots
import local.asb.companion.ui.inspectorReason
import local.asb.companion.ui.muteChoiceText
import local.asb.companion.ui.muteFlagText
import local.asb.companion.ui.pillCounts
import local.asb.companion.ui.workingClockMs
import local.asb.companion.ui.workingDuration
import local.asb.companion.ui.workingSignAlpha
import org.junit.Assert.assertEquals
import org.junit.Test

/** Android council round 2, list, card, and inspector fixes (made-up rows). */
class AndroidCouncilRoundTwoListTest {
    // 2027-01-15 08:00 UTC, a Friday.
    private val now = 1_800_000_000_000L
    private val utc = ZoneOffset.UTC
    private val idle = Thread(state = "idle", updatedAtMs = now, title = "fix flaky upload test")
    private val rows = listOf(
        idle.copy(id = "q", pending = true, questionAttention = true, state = "waiting"),
        idle.copy(id = "dot", pending = true, unread = true, provider = "codex"),
        idle.copy(id = "w1", state = "working", workingSinceMs = now),
        idle.copy(id = "w2", state = "working", workingSinceMs = now, pending = true, drawer = true),
        idle.copy(id = "d", drawer = true, unread = true),
        idle.copy(id = "a", drawer = true, archived = true),
    )

    @Test fun pillCountsStayTheSameWithAPillOrAStateFilterOn() {
        val plain = pillCounts(rows, Filter())
        assertEquals(3, plain.pending)
        assertEquals(2, plain.working)
        assertEquals(2, plain.drawer)
        for (filter in listOf(
            Filter(pendingOnly = true), Filter(states = setOf("idle")), Filter(states = setOf("working")),
            Filter(drawerOnly = true), Filter(app = "codex", query = "flaky"),
        )) assertEquals(filter.toString(), plain, pillCounts(rows, filter))
    }

    @Test fun thePulseHasEightStepsPerPeriodAndIsStillWithAnimationsOff() {
        assertEquals(8, WORKING_PULSE_STEPS)
        assertEquals(WORKING_PULSE_MS.toLong(), WORKING_PULSE_STEPS * WORKING_PULSE_STEP_MS)
        assertEquals(listOf(1f, .85f, .7f, .55f, .4f, .55f, .7f, .85f), (0 until 8).map { workingSignAlpha(false, it) }
            .map { Math.round(it * 100) / 100f })
        // The period repeats.
        for (step in 0 until 16) assertEquals(workingSignAlpha(false, step % 8), workingSignAlpha(false, step), 0f)
        for (step in 0 until 8) assertEquals(1f, workingSignAlpha(true, step), 0f)
    }

    @Test fun aWorkingTimeStaysStillWhileOffline() {
        val lastUpdate = now
        val row = idle.copy(state = "working", workingSinceMs = now - 5 * 60_000)
        fun shown(clock: Long, offline: Boolean) = workingDuration(row.workingSinceMs, workingClockMs(clock, offline, lastUpdate))
        assertEquals("5m", shown(now, offline = true))
        assertEquals("5m", shown(now + 20 * 60_000, offline = true))
        assertEquals("5m", shown(now + 3 * 3_600_000, offline = true))
        // Live again: it counts from the clock.
        assertEquals("25m", shown(now + 20 * 60_000, offline = false))
        // No good dashboard yet: nothing to freeze to.
        assertEquals(now + 1, workingClockMs(now + 1, true, 0))
    }

    @Test fun eachMuteChoiceShowsItsEndAndAMutedCardSaysUntilWhen() {
        assertEquals(listOf("30 min · until 08:30", "1 hour · until 09:00", "8 hours · until 16:00",
            "1 day · until Saturday 08:00", "Always"), MUTE_CHOICES.map { (words, duration) -> muteChoiceText(words, duration, now, utc) })
        assertEquals("Muted until 09:00", muteFlagText(idle.copy(muted = true, mutedUntilMs = now + 3_600_000), now, utc))
        assertEquals("Muted", muteFlagText(idle.copy(muted = true), now, utc))
        assertEquals("", muteFlagText(idle, now, utc))
    }

    @Test fun allCornersShareOneXAtTheCardEnd() {
        val cards = listOf(
            idle.copy(unread = true), idle.copy(pinned = true), idle.copy(unread = true, pinned = true),
            idle.copy(drawer = true, unread = true), idle.copy(drawer = true, unread = true, pinned = true),
            idle.copy(state = "waiting", questionAttention = true), idle.copy(state = "waiting", actionRequired = true),
            idle.copy(unread = true, alert = true, lastOutcome = "failed"),
        )
        for (row in cards) {
            val slots = cornerSlots(cornerControls(row, false, false, now))
            // The last slot always ends at the card's right edge: one x for every card; each next slot is one 48 dp target left.
            assertEquals(CORNER_TARGET, cornerSlotEnd(slots, slots.lastIndex))
            assertEquals(slots.indices.map { (slots.size - it) * CORNER_TARGET }, slots.indices.map { cornerSlotEnd(slots, it) })
        }
    }

    @Test fun theInspectorSaysTheReasonOfEachPendingKind() {
        assertEquals("Needs your answer", inspectorReason(idle.copy(state = "waiting", questionAttention = true), now))
        assertEquals("Waiting for approval", inspectorReason(idle.copy(state = "waiting", actionRequired = true), now))
        assertEquals("Failed", inspectorReason(idle.copy(unread = true, alert = true, lastOutcome = "failed"), now))
        assertEquals("Usage limit", inspectorReason(idle.copy(unread = true, alert = true, lastOutcome = "limit"), now))
        assertEquals("Done, unread", inspectorReason(idle.copy(unread = true, completionAttention = true), now))
        assertEquals("", inspectorReason(idle, now))
        assertEquals("", inspectorReason(idle.copy(pinned = true), now))
    }
}
