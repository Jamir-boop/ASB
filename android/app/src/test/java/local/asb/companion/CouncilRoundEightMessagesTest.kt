package local.asb.companion

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import local.asb.companion.ui.ChordLine
import local.asb.companion.ui.KeyPlan
import local.asb.companion.ui.SeatLabelInput
import local.asb.companion.ui.SeatLabelSpot
import local.asb.companion.ui.planKey
import local.asb.companion.ui.plateClip
import local.asb.companion.ui.restCrossings
import local.asb.companion.ui.statusChordWidth
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// The PC round 8 table fixes, on the phone: wide rest chords of other pairs over the label plates, no seam at a plate edge, and
// `Line width:` first in each key.
class CouncilRoundEightMessagesTest {
    // ---------- T1: wide rest chords of other pairs draw over the label plates ----------

    // The label of seat s: its plate runs from 177 to 223 and from 122 to 142; each chord runs along y = 132 from x = 190.
    private val seat = SeatLabelInput("s", -90f, listOf(Size(40f, 14f)))
    private val spots = mapOf("s" to SeatLabelSpot(0, 0, Rect(179f, 125f, 221f, 139f)))
    private fun line(key: String, a: String, width: Float, inside: Float, weight: Int = 1) =
        ChordLine(key, a, "y", width, weight, listOf(Offset(190f, 132f), Offset(190f + inside, 132f)))

    @Test fun wideAndDashedRestChordsOfOtherPairsCrossThePlate() {
        val lines = listOf(line("wide", "x", 6f, 25f), line("thin", "x", 2f, 25f), line("own", "s", 6f, 25f), line("short", "x", 6f, 12f),
            line("dashed", "x", 2f, 13f, weight = 3))
        assertEquals(mapOf("s" to listOf("wide", "dashed")), restCrossings(spots, listOf(seat), lines, 1f))
        // A hidden label has no plate.
        assertTrue(restCrossings(mapOf("s" to null), listOf(seat), lines, 1f).isEmpty())
        // On a 2 dp screen the chord must be 10 dp wide and more than 24 px inside.
        assertTrue(restCrossings(spots, listOf(seat), listOf(line("wide", "x", 6f, 25f)), 2f).isEmpty())
    }

    // ---------- T2: no seam at a plate edge ----------

    @Test fun theSecondPassClipsAtTheGrownPlateOnWholePixels() {
        assertEquals(Rect(9f, 19f, 52f, 36f), plateClip(Rect(10.3f, 20.6f, 50.2f, 34.4f), 1f))
        assertEquals(Rect(7f, 17f, 53f, 38f), plateClip(Rect(10.3f, 20.6f, 50.2f, 34.4f), 2.625f))
        // A plate on whole pixels grows by 1 dp only.
        assertEquals(Rect(9f, 19f, 51f, 36f), plateClip(Rect(10f, 20f, 50f, 35f), 1f))
    }

    // ---------- T3: `Line width:` first in each key ----------

    private val measure = { text: String -> Size(6f * text.length, 14f) }

    private fun checkOrder(key: KeyPlan, texts: List<String>, widths: List<Float>) {
        val item = key.items[0]
        assertEquals("chords", item.kind)
        assertEquals("Line width:", item.text)
        assertEquals(item.x, item.tx)
        assertEquals(texts, item.groups.map { it.text })
        assertEquals(widths, item.groups.map { it.width })
        // The first sample comes 6 dp after `Line width:`, as in the three-sample key.
        assertEquals(item.tx + measure("Line width:").width + 6f, item.groups[0].x)
        // Each 16 dp sample ends 4 dp before its text; the next sample starts 10 dp after that text.
        item.groups.forEach { assertEquals(it.x + 20f, it.tx) }
        item.groups.zipWithNext().forEach { (a, b) -> assertEquals(a.tx + measure(a.text).width + 10f, b.x) }
    }

    @Test fun theTwoSampleRestKey() {
        val key = planKey(listOf(1, 34), null, listOf("bad" to "Not sent"), measure, 1f, 400f) { it.right < 320 }!!
        checkOrder(key, listOf("1 to", "34 messages"), listOf(1.5f, 8.5f))
        assertEquals(listOf(84f, 138f), key.items[0].groups.map { it.x })
        assertEquals("Line width: 1 to 34 messages, Not sent", key.words)
        assertEquals(listOf("chords", "bad"), key.items.map { it.kind })
        // The Not sent part follows 14 dp after the last text.
        assertEquals(158f + 66f + 14f, key.items[1].x)
    }

    @Test fun theKeyOfAChosenBucketWithTwoCounts() {
        val key = planKey(listOf(1, 0, 29), "Oct 22", emptyList(), measure, 1f, 400f) { true }!!
        checkOrder(key, listOf("1 to", "29 messages (Oct 22)"), listOf(statusChordWidth(1, 29), 8.5f))
        assertTrue(key.accent)
        assertEquals("Line width: 1 to 29 messages (Oct 22)", key.words)
    }

    @Test fun theKeyOfAChosenBucketWithOneCount() {
        val key = planKey(listOf(0, 3), "Oct 22", emptyList(), measure, 1f, 400f) { true }!!
        checkOrder(key, listOf("3 messages (Oct 22)"), listOf(statusChordWidth(3, 3)))
        assertEquals("Line width: 3 messages (Oct 22)", key.words)
        assertEquals("Line width: 7 messages", planKey(listOf(7), null, emptyList(), measure, 1f, 400f) { true }!!.words)
    }
}
