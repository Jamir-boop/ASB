package local.asb.companion

import java.time.ZoneId
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Thread
import local.asb.companion.ui.MUTE_CHOICES
import local.asb.companion.ui.copyReference
import local.asb.companion.ui.muteActive
import local.asb.companion.ui.muteBody
import local.asb.companion.ui.muteFlagText
import local.asb.companion.ui.muteTip
import local.asb.companion.ui.panelFocusReturn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Android council round 1, parity: Copy reference and Mute in the inspector (made-up rows). */
class AndroidCouncilRoundOneCopyMuteTest {
    private val utc = ZoneId.of("UTC")
    // A Friday, 12:00 UTC.
    private val now = 1_800_014_400_000L
    private val row = Thread(id = "one", title = "fix flaky upload test")
    private val reference = "asb:1/0123456789abcdef/claude-local/local_00000000-0000-4000-8000-000000000000"

    @Test fun theDashboardRowsHaveTheReferenceAndMuteFields() {
        val decoded = AsbJson.decodeFromString<Thread>(
            """{"id":"one","reference":"$reference","sessionReference":"claude-desktop-code/local_x","muted":true,"mutedUntilMs":1800000000000.5}""")
        assertEquals(reference, decoded.reference)
        assertEquals("claude-desktop-code/local_x", decoded.sessionReference)
        assertEquals(1_800_000_000_000L, decoded.mutedUntilMs)
        assertEquals("old-peer", AsbJson.decodeFromString<Thread>("""{"referenceUnavailable":"old-peer"}""").referenceUnavailable)
    }

    @Test fun copyGivesTheAbsoluteReferenceOrTheReason() {
        assertEquals(reference to "", copyReference(row.copy(reference = reference)))
        assertEquals(null to "travel-laptop has an older ASB. Update ASB on that machine.",
            copyReference(row.copy(referenceUnavailable = "old-peer", machineName = "travel-laptop", remote = true)))
        assertEquals(null to "travel-laptop did not send the profile of this session.",
            copyReference(row.copy(referenceUnavailable = "unknown-source", machineName = "travel-laptop", remote = true)))
        assertEquals(null to "ASB does not know the profile of this session.", copyReference(row.copy(referenceUnavailable = "unknown-source")))
        assertEquals(null to "The ASB engine on the PC is older. Update ASB on the PC.", copyReference(row))
        assertEquals(null to "ASB cannot make a full reference for this session.", copyReference(row.copy(referenceUnavailable = "new-code")))
        // A value that is not one safe line is not copied.
        assertNull(copyReference(row.copy(reference = "asb:1/a b")).first)
        assertNull(copyReference(row.copy(reference = "asb:1/" + "a".repeat(400))).first)
    }

    @Test fun muteOffersTheBoardChoicesWithTheirBodies() {
        assertEquals(listOf("30 min", "1 hour", "8 hours", "1 day", "Always"), MUTE_CHOICES.map { it.first })
        assertEquals(listOf("""{"durationMs":1800000}""", """{"durationMs":3600000}""", """{"durationMs":28800000}""",
            """{"durationMs":86400000}""", "{}"), MUTE_CHOICES.map { muteBody(it.second) })
        assertEquals("Mute for 30 minutes", muteTip("30 min"))
        assertEquals("Mute for 8 hours", muteTip("8 hours"))
        assertEquals("Mute until you unmute", muteTip("Always"))
    }

    @Test fun aMutedRowSaysUntilWhen() {
        assertEquals("", muteFlagText(row, now, utc))
        assertEquals("Muted", muteFlagText(row.copy(muted = true), now, utc))
        val timed = row.copy(muted = true, mutedUntilMs = now + 9_000_000)
        assertTrue(muteActive(timed, now))
        assertEquals("Muted until 14:30", muteFlagText(timed, now, utc))
        assertEquals("Muted until Saturday 12:00", muteFlagText(row.copy(muted = true, mutedUntilMs = now + 86_400_000), now, utc))
        // A timed mute that ended is not shown before the next dashboard.
        assertFalse(muteActive(timed, timed.mutedUntilMs))
        assertEquals("", muteFlagText(timed, timed.mutedUntilMs, utc))
    }

    @Test fun theFocusMovesBetweenMuteAndUnmute() {
        assertEquals("mute", panelFocusReturn("mute", emptyMap()))
        assertEquals("mute", panelFocusReturn("mute:8 hours", emptyMap()))
    }
}
