package local.asb.companion

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import java.util.TimeZone
import kotlin.math.max
import kotlin.math.min
import local.asb.companion.data.ActivityBuckets
import local.asb.companion.data.ActivityMessage
import local.asb.companion.data.ActivityMessages
import local.asb.companion.data.Chord
import local.asb.companion.data.bucketPairCounts
import local.asb.companion.data.contrast
import local.asb.companion.data.mixColor
import local.asb.companion.data.offlineBandColor
import local.asb.companion.data.offlineRingColor
import local.asb.companion.ui.ChordLine
import local.asb.companion.ui.LabelTable
import local.asb.companion.ui.SeatLabelInput
import local.asb.companion.ui.SeatLabelSpot
import local.asb.companion.ui.keyMiddle
import local.asb.companion.ui.labelPlate
import local.asb.companion.ui.messageBucketReadout
import local.asb.companion.ui.offlineDashes
import local.asb.companion.ui.placeSeatLabels
import local.asb.companion.ui.planKey
import local.asb.companion.ui.plateCrossings
import local.asb.companion.ui.seatLabelLate
import local.asb.companion.ui.seatLabelTexts
import local.asb.companion.ui.smoothCurve
import local.asb.companion.ui.stackedFault
import local.asb.companion.ui.statusChordWidth
import local.asb.companion.ui.strayFault
import local.asb.companion.ui.stripDotRadius
import local.asb.companion.ui.stripReadoutPlace
import local.asb.companion.ui.tableLit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The PC round 6 and round 7 Messages changes, on the phone: label plates, lit chords over the plates, the label rules, the dashed
// offline band and pin rings, the key with three samples that drops parts, the strip curve and readout, and the chords of a
// chosen hour or day.
class CouncilRoundSevenMessagesTest {
    private val center = Offset(200f, 200f)
    private val open = LabelTable(center, 100f, 0f, false, 400f, 400f, emptyList())

    private fun place(seats: List<SeatLabelInput>, table: LabelTable, chosen: List<String> = emptyList(),
        previous: Map<String, SeatLabelSpot?> = emptyMap(), lit: Set<String> = emptySet(), messages: Map<String, Int> = emptyMap()) =
        placeSeatLabels(seats, chosen, messages, emptyMap(), table, 1f, previous = previous, litChords = lit)

    // ---------- Task 1: plates ----------

    @Test fun thePlateIsThreeDpOutsideTheInk() {
        // The box is 1 dp wider than the text at each side; the ink is measured from the text top left.
        assertEquals(Rect(9f, 20f, 53f, 35f), labelPlate(Rect(10f, 20f, 52f, 34f), Rect(1f, 3f, 39f, 12f), 1f))
        // On a 2 dp screen: 2 dp from the box to the text, and 6 dp outside the ink.
        assertEquals(Rect(8f, 20f, 57f, 50f), labelPlate(Rect(10f, 20f, 52f, 34f), Rect(2f, 6f, 39f, 24f), 2f))
    }

    // ---------- Task 2: lit chords over the plates ----------

    @Test fun aLitChordCrossesAPlateWhenOneDpOfItIsInside() {
        val seat = SeatLabelInput("s", -90f, listOf(Size(40f, 14f)))
        val spot = SeatLabelSpot(0, 0, Rect(179f, 125f, 221f, 139f))
        // The plate runs from 177 to 223 and from 122 to 142.
        val crossing = ChordLine("s|t", "s", "t", 2f, 1, listOf(Offset(222f, 132f), Offset(240f, 132f)))
        val grazing = ChordLine("u|v", "u", "v", 2f, 1, listOf(Offset(222.5f, 132f), Offset(240f, 132f)))
        val inside = plateCrossings(mapOf("s" to spot), listOf(seat), listOf(crossing, grazing), setOf("s|t", "u|v"), 1f)
        assertEquals(mapOf("s" to listOf("s|t")), inside)
        // Only the lit chords count.
        assertTrue(plateCrossings(mapOf("s" to spot), listOf(seat), listOf(crossing), setOf("u|v"), 1f).isEmpty())
        // A hidden label has no plate.
        assertTrue(plateCrossings(mapOf("s" to null), listOf(seat), listOf(crossing), setOf("s|t"), 1f).isEmpty())
    }

    // ---------- Task 3: label rules ----------

    @Test fun aWholeNameInALaterPlaceComesBeforeACutNameInTheFirstPlace() {
        // The blocker covers the right end of the whole inward and under boxes, not the cut inward box.
        val seat = SeatLabelInput("s", -90f, listOf(Size(60f, 14f), Size(30f, 14f)))
        val table = LabelTable(center, 100f, 0f, false, 400f, 400f, listOf(Rect(220f, 115f, 240f, 140f)))
        assertEquals(0 to 2, place(listOf(seat), table).getValue("s")!!.let { it.text to it.place })
    }

    // Only the inward (0) and the over (2) places of a 40 × 14 label of the top seat are free: (179, 125) to (221, 139) and
    // (179, 65) to (221, 79).
    private val twoPlaces = listOf(Rect(0f, 0f, 400f, 64f), Rect(0f, 80f, 400f, 124f), Rect(0f, 140f, 400f, 400f),
        Rect(0f, 64f, 178f, 141f), Rect(222f, 64f, 400f, 141f))
    private val own = ChordLine("s|z", "s", "z", 2f, 1, listOf(Offset(150f, 72f), Offset(250f, 72f)))
    private fun other(length: Float) = ChordLine("x|y", "x", "y", 2f, 1, listOf(Offset(190f, 132f), Offset(190f + length, 132f)))

    @Test fun aPlateOverMoreThanTwelveDpOfAChordOfAnotherPairRanksLate() {
        val seat = SeatLabelInput("s", -90f, listOf(Size(40f, 14f)))
        fun at(lines: List<ChordLine>) = place(listOf(seat), LabelTable(center, 100f, 0f, false, 400f, 400f, twoPlaces, lines = lines)).getValue("s")!!.place
        // 13 dp of a 2 dp chord of another pair under the inward plate: the label goes over its pin, on more ink of its own chord.
        assertEquals(2, at(listOf(other(13f), own)))
        // 12 dp only: the inward plate has less ink.
        assertEquals(0, at(listOf(other(12f), own)))
        // 13 dp of a 2 dp chord of its own pair is not heavy.
        assertEquals(0, at(listOf(ChordLine("s|y", "s", "y", 2f, 1, listOf(Offset(190f, 132f), Offset(203f, 132f))), own)))
        // 13 dp of its own chord of 5 dp is heavy.
        assertEquals(2, at(listOf(ChordLine("s|y", "s", "y", 5f, 1, listOf(Offset(190f, 132f), Offset(203f, 132f))), own)))
    }

    @Test fun lessChordInkComesFirstInStepsOfEightSquareDp() {
        val seat = SeatLabelInput("s", -90f, listOf(Size(40f, 14f)))
        fun at(lines: List<ChordLine>) = place(listOf(seat), LabelTable(center, 100f, 0f, false, 400f, 400f, twoPlaces, lines = lines)).getValue("s")!!.place
        // 3 dp of a 2 dp chord is 6 dp², step 0 as the empty plate: the place order keeps the inward place.
        assertEquals(0, at(listOf(ChordLine("s|y", "s", "y", 2f, 1, listOf(Offset(190f, 132f), Offset(193f, 132f))))))
        // 4 dp is 8 dp², step 1.
        assertEquals(2, at(listOf(ChordLine("s|y", "s", "y", 2f, 1, listOf(Offset(190f, 132f), Offset(194f, 132f))))))
        // An all-not-sent chord counts 3 times.
        assertEquals(2, at(listOf(ChordLine("s|y", "s", "y", 2f, 3, listOf(Offset(190f, 132f), Offset(192f, 132f))))))
    }

    @Test fun stackedAndStrayFaults() {
        val box = Rect(100f, 100f, 140f, 114f)
        // Another label 11 dp under it with an x overlap stacks; 12 dp does not; no x overlap does not.
        assertTrue(stackedFault(box, null, listOf(Rect(120f, 125f, 160f, 139f) to null), 1f))
        assertFalse(stackedFault(box, null, listOf(Rect(120f, 126f, 160f, 140f) to null), 1f))
        assertFalse(stackedFault(box, null, listOf(Rect(139.5f, 120f, 180f, 134f) to null), 1f))
        // Or under 4 dp more than the gap of one of the two labels to its own 16 dp pin: this label is 10 dp from its pin rim.
        val pin = Offset(120f, 140f)
        assertTrue(stackedFault(box, pin, listOf(Rect(120f, 127f, 160f, 141f) to null), 1f))
        assertFalse(stackedFault(box, pin, listOf(Rect(120f, 128f, 160f, 142f) to null), 1f))
        // Stray: the center (120, 107) is not 4 dp nearer its own pin than another pin.
        assertFalse(strayFault(box, Offset(120f, 87f), listOf(Offset(120f, 131f)), 1f))
        assertTrue(strayFault(box, Offset(120f, 87f), listOf(Offset(120f, 130f)), 1f))
        assertFalse(strayFault(box, null, listOf(Offset(120f, 107f)), 1f))
    }

    // The top seat a (120 × 14) has only its inward box (139, 125) to (261, 139); the seat b at -48.59° (pin near 266, 125) has
    // only its under box (245, 146) to (287, 160), 7 dp under the label of a: a stacked fault.
    private val stackHoles = listOf(Rect(0f, 0f, 400f, 124f), Rect(0f, 161f, 400f, 400f), Rect(0f, 124f, 138f, 161f),
        Rect(262f, 124f, 400f, 145f), Rect(138f, 140f, 244f, 161f), Rect(288f, 145f, 400f, 161f))
    private val a = SeatLabelInput("a", -90f, listOf(Size(120f, 14f)))
    private val b = SeatLabelInput("b", -48.59f, listOf(Size(40f, 14f)))

    @Test fun inTheSmallTableALabelThatCanOnlyStackHides() {
        val small = LabelTable(center, 100f, 0f, false, 400f, 400f, stackHoles)
        val spots = place(listOf(a, b), small, messages = mapOf("a" to 2))
        assertEquals(0, spots.getValue("a")!!.place)
        assertNull(spots.getValue("b"))
        // A table with a center disc keeps it.
        val large = LabelTable(center, 100f, 0f, true, 400f, 400f, stackHoles)
        assertEquals(1, place(listOf(a, b), large, messages = mapOf("a" to 2)).getValue("b")!!.place)
        // A chosen seat keeps it too.
        assertEquals(1, place(listOf(a, b), small, chosen = listOf("b"), messages = mapOf("a" to 2)).getValue("b")!!.place)
    }

    @Test fun aSeatThatIsNotChosenLeavesAPlateOverALitChordOfAnotherPair() {
        val seat = SeatLabelInput("s", -90f, listOf(Size(40f, 14f)))
        val table = LabelTable(center, 100f, 0f, false, 400f, 400f, emptyList(), lines = listOf(other(13f)))
        val kept = mapOf("s" to SeatLabelSpot(0, 0, Rect(179f, 125f, 221f, 139f)))
        // At rest the label keeps its inward place.
        assertEquals(0, place(listOf(seat), table, previous = kept).getValue("s")!!.place)
        // The chord lights: the label takes its first free candidate, off the chord.
        assertNotEquals(0, place(listOf(seat), table, previous = kept, lit = setOf("x|y")).getValue("s")!!.place)
        assertEquals(2, place(listOf(seat), table, previous = kept, lit = setOf("x|y")).getValue("s")!!.place)
        // A chosen seat keeps it.
        assertEquals(0, place(listOf(seat), table, chosen = listOf("s"), previous = kept, lit = setOf("x|y")).getValue("s")!!.place)
    }

    @Test fun aLateCutShowsOnlyWhenAllPassesFail() {
        val texts = seatLabelTexts("ui-polish")
        assertEquals(listOf("ui-polish", "ui-poli…"), texts)
        assertEquals(1, seatLabelLate(texts, "ui-polish"))
        // A cut 3 or more characters shorter is not late.
        assertEquals(listOf("Twelve chars", "Twelve \nchars", "Twelve…", "Twelve cha…"), seatLabelTexts("Twelve chars"))
        assertEquals(3, seatLabelLate(seatLabelTexts("Twelve chars"), "Twelve chars"))
        assertEquals(1, seatLabelLate(listOf("Short"), "Short"))
        val seat = SeatLabelInput("s", -90f, listOf(Size(60f, 14f), Size(50f, 14f)), late = 1)
        // In an open table the whole name shows.
        assertEquals(0, place(listOf(seat), open).getValue("s")!!.text)
        // Only the inward box of the 50 dp cut is free: (174, 125) to (226, 139).
        val narrow = LabelTable(center, 100f, 0f, false, 400f, 400f, listOf(Rect(0f, 0f, 400f, 124f), Rect(0f, 140f, 400f, 400f),
            Rect(0f, 124f, 173f, 140f), Rect(227f, 124f, 400f, 140f)))
        assertEquals(1 to 0, place(listOf(seat), narrow).getValue("s")!!.let { it.text to it.place })
        // A chosen seat never takes a late cut: it shows its one-line name inward.
        assertEquals(0 to 0, place(listOf(seat), narrow, chosen = listOf("s")).getValue("s")!!.let { it.text to it.place })
    }

    // ---------- Task 4: the offline band and pin rings ----------

    @Test fun theOfflineBandIsAWholeNumberOfDashes() {
        // A 90° arc at a middle radius of 105 dp is 164.9 dp: 11 dashes of 11.4 dp with 4 dp gaps.
        val dashes = offlineDashes(100f, 110f, 0f, 90f, 1f)
        assertEquals(11, dashes.size)
        assertEquals(0f, dashes.first().first, .001f)
        assertEquals(90f, dashes.last().second, .01f)
        val length = { d: Pair<Float, Float> -> Math.toRadians((d.second - d.first).toDouble()).toFloat() * 105f }
        dashes.forEach { assertEquals(11.357f, length(it), .01f) }
        dashes.zipWithNext().forEach { (p, q) -> assertEquals(4f, Math.toRadians((q.first - p.second).toDouble()).toFloat() * 105f, .01f) }
        // A short arc keeps one dash; on a 2 dp screen a table twice as large has the same dashes.
        assertEquals(1, offlineDashes(100f, 110f, 0f, 3f, 1f).size)
        assertEquals(11, offlineDashes(200f, 220f, 0f, 90f, 2f).size)
    }

    @Test fun offlineColors() {
        // The band keeps offlineBandColor: the hue 55% toward the background, or less, with 3:1.
        assertEquals("#7b6584", offlineBandColor("#222226", "#b692c3"))
        assertTrue(contrast(offlineBandColor("#222226", "#b692c3"), "#222226") >= 3)
        // The rest ring of an offline pin has 3:1 on its sector tint, moved toward the text.
        for ((win, text, hue) in listOf(Triple("#222226", "#f2f2f2", "#6a5acd"), Triple("#ffffff", "#1d1d20", "#d6a15e"))) {
            val ring = offlineRingColor(win, text, hue)
            assertTrue(contrast(ring, mixColor(win, hue, .03)) >= 3)
        }
        // A hue with 3:1 already stays.
        assertEquals("#b692c3", offlineRingColor("#222226", "#f2f2f2", "#b692c3"))
    }

    // ---------- Task 5: the key ----------

    private val measure = { text: String -> Size(6f * text.length, 14f) }
    private val rest = listOf("bad" to "Not sent", "mixed" to "Some not sent", "offline" to "Offline")

    @Test fun theKeyNamesThreeCounts() {
        assertEquals(35, keyMiddle(139))
        val key = planKey(listOf(4, 139, 60, 0), null, rest.take(1), measure, 1f, 400f) { true }!!
        assertEquals("Line width: 4, 35, and 139 messages, Not sent", key.words)
        assertEquals(listOf("scale", "bad"), key.items.map { it.kind })
        val groups = key.items[0].groups
        // Each 16 dp sample at its real width, 4 dp before its count, 10 dp apart.
        assertEquals(listOf(1.5f + 7 * kotlin.math.sqrt(4f / 139), 1.5f + 7 * kotlin.math.sqrt(35f / 139), 8.5f), groups.map { it.width })
        assertEquals(listOf(84f, 120f, 162f), groups.map { it.x })
        assertEquals(groups.map { it.x + 20f }, groups.map { it.tx })
        assertEquals(listOf("4", "35", "139 messages"), groups.map { it.text })
        assertEquals(Rect(12f, 374f, 340f, 388f), key.box)
    }

    @Test fun theKeyFallsBackToTwoSamples() {
        // The middle count of 1 and 2 is not between them.
        assertEquals("Line width: 1 to 2 messages", planKey(listOf(1, 2), null, emptyList(), measure, 1f, 400f) { true }!!.words)
        // The three samples do not fit.
        val key = planKey(listOf(1, 34), null, emptyList(), measure, 1f, 400f) { it.right < 230 }!!
        assertEquals("Line width: 1 to 34 messages", key.words)
        assertEquals(1.5f to 8.5f, key.widths)
        assertFalse(key.accent)
        assertEquals("Line width: 7 messages", planKey(listOf(7, 7), null, emptyList(), measure, 1f, 400f) { true }!!.words)
        assertNull(planKey(listOf(0), null, rest, measure, 1f, 400f) { true })
    }

    @Test fun aKeyThatDoesNotFitDropsItsLastPartsFirst() {
        // The two-sample key is 218 dp wide alone, 304 with Not sent, 420 with Some not sent, and 502 with Offline (round 8).
        fun words(limit: Float) = planKey(listOf(1, 2), null, rest, measure, 1f, 400f) { it.right <= limit }!!.let { it.shown to it.words }
        assertEquals(true to "Line width: 1 to 2 messages, Not sent, Some not sent, Offline", words(502f))
        assertEquals(true to "Line width: 1 to 2 messages, Not sent, Some not sent", words(420f))
        assertEquals(true to "Line width: 1 to 2 messages, Not sent", words(310f))
        assertEquals(true to "Line width: 1 to 2 messages", words(220f))
        assertFalse(words(200f).first)
    }

    // ---------- Task 6: the strip curve ----------

    @Test fun theStripCurveIsMonotone() {
        val points = listOf(Offset(0f, 10f), Offset(10f, 0f), Offset(20f, 5f), Offset(30f, 5f), Offset(40f, 20f), Offset(41f, 2f))
        val segments = smoothCurve(points)
        assertEquals(points.size - 1, segments.size)
        for ((i, segment) in segments.withIndex()) {
            val (p, c1, c2, q) = segment
            assertEquals(points[i], p)
            assertEquals(points[i + 1], q)
            for (step in 0..40) {
                val t = step / 40f
                val u = 1 - t
                val y = u * u * u * p.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * q.y
                assertTrue("segment $i at $t", y >= min(p.y, q.y) - 1e-3f && y <= max(p.y, q.y) + 1e-3f)
            }
        }
        // A flat step stays flat.
        assertEquals(5f, segments[2][1].y)
        assertEquals(5f, segments[2][2].y)
        assertTrue(smoothCurve(points.take(1)).isEmpty())
    }

    @Test fun notSentDotsGetSmallerWhenBucketsAreClose() {
        // 24 buckets on a 300 dp strip are 12.8 dp apart; 7 buckets 49 dp.
        assertEquals(2f, stripDotRadius(24, 300f, 3f, 1f))
        assertEquals(3f, stripDotRadius(7, 300f, 3f, 1f))
        assertEquals(3f, stripDotRadius(1, 300f, 3f, 1f))
        assertEquals(4f, stripDotRadius(24, 600f, 6f, 2f))
    }

    // ---------- Task 7: the strip readout ----------

    @Test fun theReadoutText() = utc {
        assertEquals("Oct 22 · 84 messages · 2 not sent", messageBucketReadout(at("2026-10-22T00:00:00Z"), 84, 2, "day"))
        assertEquals("16:00 so far · 4 messages", messageBucketReadout(at("2026-10-26T16:00:00Z"), 4, 0, "hour", partial = true))
        assertEquals("14:00 · 1 message", messageBucketReadout(at("2026-10-26T14:00:00Z"), 1, 0, "hour"))
    }

    @Test fun theReadoutStandsBetweenTheEndNamesElseAlone() {
        // Names end at 40 and start at 260: 196 dp of room with 12 dp from each.
        assertEquals(true to 100f, stripReadoutPlace(100f, 40f, 260f, 300f, true, 1f))
        assertEquals(true to 52f, stripReadoutPlace(196f, 40f, 260f, 300f, true, 1f))
        // It does not fit: the end names hide and it centers in the row.
        assertEquals(false to 51.5f, stripReadoutPlace(197f, 40f, 260f, 300f, true, 1f))
        // Wider than the row: it ellipsizes from the left edge.
        assertEquals(false to 0f, stripReadoutPlace(400f, 40f, 260f, 300f, true, 1f))
        // One bucket has one name only.
        assertEquals(false to 100f, stripReadoutPlace(100f, 40f, 260f, 300f, false, 1f))
    }

    // ---------- Task 8: the chords of a chosen hour or day ----------

    private val hour = 3_600_000L
    private fun message(from: String, to: String, atMs: Long) = ActivityMessage(id = "$from$to$atMs", from = from, to = to, atMs = atMs, status = "accepted")
    private val chordList = listOf(Chord("a", "b", 5, 0, false), Chord("a", "c", 4, 0, false), Chord("c", "d", 9, 0, false), Chord("b", "d", 1, 0, false))
    private val reply = ActivityMessages(period = "24h", nowMs = 3 * hour + 5, buckets = ActivityBuckets("hour", listOf(0L, hour, 2 * hour), endMs = 3 * hour),
        messages = listOf(message("a", "b", hour + 1), message("c", "a", hour + 2), message("a", "c", hour + 3), message("a", "c", hour + 4),
            message("a", "c", hour + 5)) + (1..9).map { message("d", "c", hour + 10 + it) } + listOf(message("b", "d", 10), message("a", "b", 3 * hour),
            message("x", "y", hour + 6)))

    @Test fun theBucketCountsOfEachPair() {
        assertEquals(mapOf("a|b" to 1, "a|c" to 4, "c|d" to 9, "b|d" to 0), bucketPairCounts(reply, 1, chordList))
        assertEquals(mapOf("a|b" to 0, "a|c" to 0, "c|d" to 0, "b|d" to 1), bucketPairCounts(reply, 0, chordList))
        // The last bucket ends at endMs: a message at that time counts in none.
        assertEquals(0, bucketPairCounts(reply, 2, chordList).values.sum())
        assertTrue(bucketPairCounts(reply, 3, chordList).isEmpty())
    }

    @Test fun aChosenBucketLightsItsChordsAndTheirPins() {
        val counts = bucketPairCounts(reply, 1, chordList)
        val lit = tableLit(chordList, null, null, counts)
        assertEquals(setOf("a|b", "a|c", "c|d"), lit.chords)
        assertEquals(setOf("a", "b", "c", "d"), lit.pins)
        assertEquals(counts, lit.counts)
        // Each lit chord has the status chord width of its count: linear up to 7 messages.
        assertEquals(listOf(1.5f + 7f / 9, 1.5f + 28f / 9, 8.5f), listOf(1, 4, 9).map { statusChordWidth(it, 9) })
        // One message adds at most 1 dp.
        assertEquals(4.5f, statusChordWidth(3, 3))
        assertEquals(1.5f + 7f / 29, statusChordWidth(1, 29))
        // A chosen seat or chord has priority.
        val seat = tableLit(chordList, "b", null, counts)
        assertEquals(setOf("a|b", "b|d"), seat.chords)
        assertEquals(setOf("a", "b", "d"), seat.pins)
        assertNull(seat.counts)
        assertEquals(setOf("c|d"), tableLit(chordList, null, chordList[2], counts).chords)
        // A bucket with no seated pair lights nothing.
        val none = tableLit(chordList, null, null, bucketPairCounts(reply, 2, chordList))
        assertFalse(none.lighting)
        assertNull(none.counts)
    }

    @Test fun theKeyOfAChosenBucket() {
        val key = planKey(listOf(1, 4, 29), "Oct 22", rest.take(1), measure, 1f, 400f) { true }!!
        assertEquals("Line width: 1 to 29 messages (Oct 22), Not sent", key.words)
        assertEquals(listOf("chords", "bad"), key.items.map { it.kind })
        assertTrue(key.accent)
        assertEquals(statusChordWidth(1, 29) to 8.5f, key.widths)
        assertEquals("Line width: 3 messages (16:00)", planKey(listOf(0, 3), "16:00", emptyList(), measure, 1f, 400f) { true }!!.words)
        assertEquals("Line width: 1 message (Oct 22)", planKey(listOf(1), "Oct 22", emptyList(), measure, 1f, 400f) { true }!!.words)
    }

    private fun utc(body: () -> Unit) {
        val zone = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
        try { body() } finally { TimeZone.setDefault(zone) }
    }

    private fun at(text: String) = java.time.Instant.parse(text).toEpochMilli()
}
