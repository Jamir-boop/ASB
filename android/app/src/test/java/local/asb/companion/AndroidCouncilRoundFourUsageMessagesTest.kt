package local.asb.companion

import androidx.compose.ui.unit.dp
import local.asb.companion.data.Chord
import local.asb.companion.ui.BUSY_PAIR_MIN_HEIGHT
import local.asb.companion.ui.MACHINE_STATE_END
import local.asb.companion.ui.factLines
import local.asb.companion.ui.meaningsButtonText
import local.asb.companion.ui.pairCountsText
import local.asb.companion.ui.threadAnchor
import local.asb.companion.ui.threadOpenScroll
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Android council round 4: the pair row height, the machine facts, the pair head, the thread position, and the status button.
class AndroidCouncilRoundFourUsageMessagesTest {
    @Test fun busyPairRowsAreTouchTargets() {
        assertEquals(48.dp, BUSY_PAIR_MIN_HEIGHT)
    }

    @Test fun machineStateBreaksOnlyBetweenWholeFacts() {
        // 6 px per character: a fixed measure for the split.
        val measure = { text: String -> text.length * 6f }
        val line = "Offline · seen Oct 14, 2025, 08:44"
        val seen = "seen\u00a0Oct\u00a014,\u00a02025,\u00a008:44"
        assertEquals(listOf("Offline · $seen"), factLines(line, 400f, measure))
        // At the break the ` · ` goes, and the words of the seen fact stay on one line.
        assertEquals(listOf("Offline", seen), factLines(line, 150f, measure))
        // Only a fact wider than the row breaks inside, between its words.
        assertEquals(listOf("Offline", "seen Oct 14, 2025, 08:44"), factLines(line, 100f, measure))
        // The state runs under the bar up to the value column: 84 dp value, 44 dp share, two 8 dp gaps.
        assertEquals(144.dp, MACHINE_STATE_END)
    }

    @Test fun pairHeadIsOneLine() {
        assertEquals("→ 115  ← 115", pairCountsText(Chord("a", "b", 115, 115, false)))
        assertEquals("→ 1,200  ← 3", pairCountsText(Chord("a", "b", 1200, 3, false, badAb = 1)))
    }

    @Test fun threadOpensAtTheNewestMessage() {
        // The panel to the thread end fits: the panel top goes to the viewport top.
        assertEquals(500, threadOpenScroll(300, 200f, 700f, 0f, 800f))
        // A long thread: its end (the newest message) goes to the viewport bottom.
        assertEquals(1700, threadOpenScroll(300, 200f, 2200f, 0f, 800f))
        // Never above the page top.
        assertEquals(0, threadOpenScroll(0, -50f, 300f, 0f, 800f))
    }

    @Test fun showEarlierKeepsTheMessageInView() {
        val spans = listOf(Triple("m1", -300f, -100f), Triple("m2", -100f, 40f), Triple("m3", 40f, 200f))
        assertEquals("m2", threadAnchor(spans, 0f))
        assertEquals("m3", threadAnchor(spans, 40f))
        assertNull(threadAnchor(spans, 500f))
    }

    @Test fun meaningsButtonWords() {
        assertEquals("Show meanings", meaningsButtonText(false))
        assertEquals("Hide meanings", meaningsButtonText(true))
    }
}
