package local.asb.companion

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import java.util.TimeZone
import local.asb.companion.data.ActivityMachine
import local.asb.companion.data.ActivityMessage
import local.asb.companion.data.ActivityMessages
import local.asb.companion.data.AsbJson
import local.asb.companion.data.BucketCount
import local.asb.companion.data.Chord
import local.asb.companion.data.Seat
import local.asb.companion.data.SeatCount
import local.asb.companion.data.messageBuckets
import local.asb.companion.data.messageFailureReason
import local.asb.companion.data.messageStatusLabel
import local.asb.companion.data.seatCounts
import local.asb.companion.ui.LabelTable
import local.asb.companion.ui.SeatLabelInput
import local.asb.companion.ui.SeatLabelSpot
import local.asb.companion.ui.chordText
import local.asb.companion.ui.messageBucketTip
import local.asb.companion.ui.notSentEndSpan
import local.asb.companion.ui.pinCircle
import local.asb.companion.ui.placeSeatLabels
import local.asb.companion.ui.seatLabelTexts
import local.asb.companion.ui.seatLabelWholeCount
import local.asb.companion.ui.stripBucketAt
import local.asb.companion.ui.stripBucketName
import local.asb.companion.ui.stripTipLeft
import local.asb.companion.ui.stripX
import local.asb.companion.ui.stripY
import local.asb.companion.ui.strokeTrim
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The PC round 4 Messages changes (44e5a6e, c7b0200, and b3878ce), on the phone: M1, M3, M5, M8, M11, M12, M15, D9 A, and D12 A.
class CouncilRoundFourMessagesTest {
    private val center = Offset(200f, 200f)

    // ---------- Task 1: not-sent ends ----------

    @Test fun notSentEndsRun24DpFromTheRim() {
        assertEquals(384f to 360f, notSentEndSpan(400f, 1f, forward = true))
        assertEquals(16f to 40f, notSentEndSpan(400f, 1f, forward = false))
        assertEquals(32f to 80f, notSentEndSpan(1000f, 2f, forward = false))
        // At most half of the chord.
        assertEquals(24f to 4f, notSentEndSpan(40f, 1f, forward = true))
    }

    @Test fun chordStrokeStopsTwoDpBeforeItsEnds() {
        // A 400 px chord with an end at each pin: the 8 px stroke (4 px round caps) stops 2 px + 4 px before each end.
        val length = 400f
        val trim = notSentEndSpan(length, 1f, forward = false).second / length to notSentEndSpan(length, 1f, forward = true).second / length
        val (low, high) = strokeTrim(trim, length, 8f, 1f)
        assertEquals(46f, low * length, .01f)
        assertEquals(354f, high * length, .01f)
        // The round cap reaches 4 px further: 2 px of background stays before each end.
        assertEquals(2f, 360f - (high * length + 4f), .01f)
        assertEquals(2f, (low * length - 4f) - 40f, .01f)
        // An untrimmed side keeps its pin end.
        val one = strokeTrim(0f to .9f, length, 8f, 1f)
        assertEquals(0f, one.first)
        assertEquals(.885f, one.second, .0001f)
    }

    // ---------- Task 3: seat labels (tasks 2 and 4 are drawing only: drawKey and drawTable) ----------

    @Test fun seatLabelTextsAddATwoLineText() {
        val long = "fix-the-session-list-scroll-on-small-screens"
        // Its first line would have more than 24 characters: no two-line text.
        assertEquals(listOf(long.take(24) + "…", "fix-the-se…", "fix-the…"), seatLabelTexts(long))
        assertEquals(1, seatLabelWholeCount(seatLabelTexts(long)))
        assertEquals(listOf("abcdefghijklmnopqrst-uvw…", "abcdefghijklmnopqrst-\nuvwxyzabcdef", "abcdefghij…", "abcdefg…"),
            seatLabelTexts("abcdefghijklmnopqrst-uvwxyzabcdef"))
        assertEquals(2, seatLabelWholeCount(seatLabelTexts("abcdefghijklmnopqrst-uvwxyzabcdef")))
        assertEquals(listOf("render-farm", "render-\nfarm", "render-far…", "render…"), seatLabelTexts("render-farm"))
        assertEquals(2, seatLabelWholeCount(seatLabelTexts("render-farm")))
        // A cut drops trailing separators before the ….
        assertEquals("parser…", seatLabelTexts("parser-review").last())
        // A break needs text on both sides.
        assertEquals(listOf("-docs"), seatLabelTexts("-docs"))
        assertEquals(listOf("docs-"), seatLabelTexts("docs-"))
    }

    private val small = listOf(Size(40f, 14f))
    private val open = LabelTable(center, 100f, 0f, false, 400f, 400f, emptyList())

    // Everything but the inward box of a 40 × 14 label of the pin at the top: (179, 123) to (221, 137).
    private val onlyInward = listOf(Rect(0f, 0f, 400f, 122f), Rect(0f, 138f, 400f, 400f), Rect(0f, 122f, 178f, 138f), Rect(222f, 122f, 400f, 138f))

    private fun labelOf(otherPinX: Float, blocked: List<Rect>): SeatLabelSpot? {
        val a = SeatLabelInput("a", -90f, small, pin = pinCircle(Offset(200f, 100f), 1f))
        val b = SeatLabelInput("b", 90f, small, pin = pinCircle(Offset(otherPinX, 130f), 1f))
        return placeSeatLabels(listOf(a, b), emptyList(), mapOf("a" to 2), emptyMap(), LabelTable(center, 100f, 0f, false, 400f, 400f, blocked), 1f)
            .getValue("a")
    }

    @Test fun labelsStayNearerTheirOwnPin() {
        // The inward box is 23 px from its own pin center (6.5 px from its circle). A pin 26 px right of the box is 9.5 px from it:
        // less than 6.5 + 4, so on an open table another place wins.
        assertEquals(0, labelOf(251f, emptyList())!!.place)
        assertTrue(labelOf(247f, emptyList())!!.place != 0)
    }

    @Test fun crowdedLabelsTakeTheTwoDpPass() {
        // Only the inward place is free of the boxes. At 9.5 px only the 2 dp pass (6.5 + 2) places the label; at 6.5 px it hides.
        assertEquals(0, labelOf(251f, onlyInward)!!.place)
        assertEquals(0, labelOf(247f, onlyInward)!!.place)
        assertNull(labelOf(244f, onlyInward))
    }

    @Test fun aSelectionKeepsAFreeLabelWhereItIs() {
        val a = SeatLabelInput("a", -90f, small)
        assertEquals(0, placeSeatLabels(listOf(a), emptyList(), emptyMap(), emptyMap(), open, 1f).getValue("a")!!.place)
        val kept = mapOf("a" to SeatLabelSpot(0, 3, Rect.Zero))
        assertEquals(3, placeSeatLabels(listOf(a), emptyList(), emptyMap(), emptyMap(), open, 1f, previous = kept).getValue("a")!!.place)
        // A kept place that is no longer free: the label places from the start.
        val left = LabelTable(center, 100f, 0f, false, 400f, 400f, listOf(Rect(150f, 90f, 185f, 110f)))
        assertEquals(0, placeSeatLabels(listOf(a), emptyList(), emptyMap(), emptyMap(), left, 1f, previous = kept).getValue("a")!!.place)
    }

    // Two holes at the top pin: the inward place (186, 122) to (214, 138) and the right place (217, 92) to (241, 108).
    private val twoHoles = listOf(Rect(0f, 0f, 400f, 92f), Rect(0f, 92f, 217f, 108f), Rect(241f, 92f, 400f, 108f), Rect(0f, 108f, 400f, 122f),
        Rect(0f, 122f, 186f, 138f), Rect(214f, 122f, 400f, 138f), Rect(0f, 138f, 400f, 400f))

    private fun repair(blocked: List<Rect>, chosen: List<String> = emptyList()): Map<String, SeatLabelSpot?> {
        // The 20 dp label fits both holes; the 24 dp label fits only the inward hole, where the first label is.
        val first = SeatLabelInput("first", -90f, listOf(Size(20f, 14f)))
        val second = SeatLabelInput("second", -90f, listOf(Size(24f, 14f)))
        return placeSeatLabels(listOf(first, second), chosen, mapOf("first" to 2, "second" to 1), emptyMap(),
            LabelTable(center, 100f, 0f, false, 400f, 400f, blocked), 1f)
    }

    @Test fun aBlockingLabelMovesBeforeASeatHides() {
        val spots = repair(twoHoles)
        assertEquals(4, spots.getValue("first")!!.place)
        assertEquals(0, spots.getValue("second")!!.place)
        // No other free place: the move is undone and the seat hides.
        val undone = repair(twoHoles + Rect(217f, 92f, 241f, 108f))
        assertEquals(0, undone.getValue("first")!!.place)
        assertNull(undone.getValue("second"))
        // A chosen label never moves.
        val chosen = repair(twoHoles, listOf("first"))
        assertEquals(0, chosen.getValue("first")!!.place)
        assertNull(chosen.getValue("second"))
    }

    @Test fun chosenSeatsTryBothWholeTextsThenShowOneLineInward() {
        val sizes = listOf(Size(120f, 14f), Size(50f, 28f), Size(40f, 14f))
        val seat = SeatLabelInput("s", -90f, sizes, whole = 2)
        // Too wide on one line and not cut for a chosen seat: the two-line text takes the inward place.
        val narrow = LabelTable(center, 100f, 0f, false, 400f, 400f, listOf(Rect(0f, 0f, 170f, 400f), Rect(230f, 0f, 400f, 400f)))
        assertEquals(1 to 0, placeSeatLabels(listOf(seat), listOf("s"), emptyMap(), emptyMap(), narrow, 1f).getValue("s")!!.let { it.text to it.place })
        val full = LabelTable(center, 100f, 0f, false, 400f, 400f, listOf(Rect(0f, 0f, 400f, 400f)))
        assertEquals(0 to 0, placeSeatLabels(listOf(seat), listOf("s"), emptyMap(), emptyMap(), full, 1f).getValue("s")!!.let { it.text to it.place })
        assertNull(placeSeatLabels(listOf(seat), emptyList(), emptyMap(), emptyMap(), full, 1f).getValue("s"))
    }

    // ---------- Tasks 5 and 6: center counts and reasons ----------

    private fun message(id: String, from: String, to: String, at: Long, status: String = "accepted", reason: String = "") =
        ActivityMessage(id, from, to, at, status, reason)

    @Test fun seatsCountNotSentPerDirection() {
        val counts = seatCounts(listOf(message("1", "a", "b", 1, "not-sent"), message("2", "a", "b", 2, "not-sent"), message("3", "b", "a", 3)))
        assertEquals(SeatCount(sent = 2, received = 1, badSent = 2, badReceived = 0), counts["a"])
        assertEquals(SeatCount(sent = 1, received = 2, badSent = 0, badReceived = 2), counts["b"])
    }

    @Test fun reasonsNameTheReceiverMachine() {
        val seats = mapOf("s1" to Seat("s1", "docs", "codex", "m1"), "s2" to Seat("s2", "plan", "codex", "m9"))
        val machines = listOf(ActivityMachine("m1", "Desk"), ActivityMachine("m2", "Studio"))
        val failed = { reason: String, to: String -> message("1", "x", to, 1, "not-sent", reason) }
        assertEquals("Not sent · Desk was not reachable", messageStatusLabel(failed("Machine offline", "s1"), seats, machines))
        assertEquals("Not sent · Refused by Desk", messageStatusLabel(failed("Refused", "s1"), seats, machines))
        assertEquals("Studio was not reachable", messageFailureReason(failed("Machine offline", "unknown:m2"), seats, machines))
        assertEquals("Too large", messageFailureReason(failed("Too large", "s1"), seats, machines))
        // No known machine name keeps the reason.
        assertEquals("Machine offline", messageFailureReason(failed("Machine offline", "s2"), seats, machines))
        assertEquals("Not sent · Machine offline", messageStatusLabel(failed("Machine offline", "s1")))
        assertEquals("Not sent", messageStatusLabel(failed("", "s1"), seats, machines))
    }

    // ---------- Task 10: chord text ----------

    @Test fun chordTextHasOnePartPerDirection() {
        val names = mapOf("a" to "release-plan", "b" to "parser-review")
        val title = { id: String -> names.getValue(id) }
        assertEquals("release-plan → parser-review: 75, parser-review → release-plan: 4, Not sent: 3",
            chordText(Chord("a", "b", 75, 4, false, 1, 2), title))
        assertEquals("release-plan → parser-review: 1,200, parser-review → release-plan: 0", chordText(Chord("a", "b", 1200, 0, false), title))
    }

    // ---------- Task 9: count strip ----------

    @Test fun bucketsCountTheirMessages() {
        val reply = AsbJson.decodeFromString<ActivityMessages>("""{"buckets":{"unit":"hour","startsMs":[0,100,200]}}""").copy(messages = listOf(
            message("1", "a", "b", -5), message("2", "a", "b", 0), message("3", "a", "b", 99), message("4", "a", "b", 100, "not-sent"),
            message("5", "a", "b", 250, "not-sent"), message("6", "b", "a", 260)))
        assertEquals("hour", reply.buckets.unit)
        assertEquals(listOf(BucketCount(0, 2, 0), BucketCount(100, 1, 1), BucketCount(200, 2, 1)), messageBuckets(reply))
        assertEquals(emptyList<BucketCount>(), messageBuckets(ActivityMessages(messages = listOf(message("1", "a", "b", 1)))))
    }

    private fun utc(body: () -> Unit) {
        val zone = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
        try { body() } finally { TimeZone.setDefault(zone) }
    }

    private fun at(text: String) = java.time.Instant.parse(text).toEpochMilli()

    @Test fun bucketTipsNameTheBucket() = utc {
        assertEquals("Oct 22: 84 messages, 2 not sent", messageBucketTip(at("2026-10-22T00:00:00Z"), 84, 2, "day"))
        assertEquals("14:00: 9 messages", messageBucketTip(at("2026-10-22T14:00:00Z"), 9, 0, "hour"))
        assertEquals("14:00: 1 message", messageBucketTip(at("2026-10-22T14:00:00Z"), 1, 0, "hour"))
        assertEquals("16:00", stripBucketName(at("2026-10-20T16:00:00Z"), "hour"))
        assertEquals("Oct 20", stripBucketName(at("2026-10-20T00:00:00Z"), "day"))
    }

    @Test fun stripPointsAndHitAreas() {
        // A 100 px strip with 3 px insets: the points run from 3 to 97.
        assertEquals(listOf(3f, 50f, 97f), (0..2).map { stripX(it, 3, 100f, 3f) })
        assertEquals(50f, stripX(0, 1, 100f, 3f))
        // y: the largest count at the top inset, zero at the bottom inset of the 24 px plot.
        assertEquals(3f, stripY(9, 9, 24f, 3f))
        assertEquals(21f, stripY(0, 9, 24f, 3f))
        assertEquals(12f, stripY(1, 2, 24f, 3f))
        assertEquals(21f, stripY(0, 0, 24f, 3f))
        // The hit areas split at the midpoints (26.5 and 73.5).
        assertEquals(0, stripBucketAt(26f, 3, 100f, 3f))
        assertEquals(1, stripBucketAt(27f, 3, 100f, 3f))
        assertEquals(2, stripBucketAt(400f, 3, 100f, 3f))
        assertNull(stripBucketAt(10f, 0, 100f, 3f))
        // The tip centers on its bucket and stays inside the strip.
        assertEquals(0f, stripTipLeft(5f, 40f, 100f))
        assertEquals(30f, stripTipLeft(50f, 40f, 100f))
        assertEquals(60f, stripTipLeft(98f, 40f, 100f))
    }
}
