package local.asb.companion

import local.asb.companion.data.STATUS_TIPS
import local.asb.companion.data.statusDescription
import local.asb.companion.ui.BarGeom
import local.asb.companion.ui.messageFoldName
import local.asb.companion.ui.scrubIndex
import local.asb.companion.ui.usageEmptyWords
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Android council round 3: the chart scrub, the Usage empty state, the thread fold names, and the status sentences (PC values).
class AndroidCouncilRoundThreeUsageMessagesTest {
    @Test fun scrubSelectsTheColumnUnderTheFinger() {
        // 24 bars from x 48 to 360 with a 2 px gap: a 13 px slot.
        val geom = BarGeom(48f, 360f, 24, 2f)
        assertEquals(0, scrubIndex(geom, 48f, null))
        assertEquals(0, scrubIndex(geom, geom.column(0).second - .1f, 5))
        assertEquals(1, scrubIndex(geom, geom.column(1).first + .1f, 0))
        assertEquals(23, scrubIndex(geom, 360f, 0))
        // Outside the plot the selection stays.
        assertEquals(7, scrubIndex(geom, 10f, 7))
        assertNull(scrubIndex(geom, 400f, null))
        assertNull(scrubIndex(BarGeom(48f, 360f, 0, 2f), 100f, null))
    }

    @Test fun usageEmptyWordsAreThePcWords() {
        assertEquals("No usage yet" to null, usageEmptyWords("all"))
        assertEquals("No usage in the last 24 hours" to "Show all time", usageEmptyWords("24h"))
        assertEquals("No usage in the last 7 days" to "Show all time", usageEmptyWords("7d"))
        assertEquals("No usage in the last 30 days" to "Show all time", usageEmptyWords("30d"))
        assertEquals("No usage in the last 90 days" to "Show all time", usageEmptyWords("90d"))
    }

    @Test fun foldNamesNameTheMessage() {
        assertEquals("Show more of the message from docs at 14:05", messageFoldName(true, "docs", "14:05"))
        assertEquals("Show less of the message from docs at 14:05", messageFoldName(false, "docs", "14:05"))
    }

    @Test fun statusSentencesAreThePcDictionary() {
        // scripts/asb-native.py MESSAGE_STATUS_TIPS
        assertEquals(mapOf(
            "accepted" to "The receiving session took the message.",
            "written" to "ASB sent the message to the receiver. No receipt came back.",
            "held" to "The receiver holds the message until its receive setting accepts it.",
            "not-sent" to "ASB did not send the message. The thread shows the reason.",
            "unknown" to "The message can have gone out, but ASB has no proof.",
        ), STATUS_TIPS)
        assertEquals("On hold. The receiver holds the message until its receive setting accepts it.", statusDescription("held"))
        assertEquals("Status unknown. The message can have gone out, but ASB has no proof.", statusDescription("lost"))
    }
}
