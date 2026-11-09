package local.asb.companion

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import java.util.TimeZone
import local.asb.companion.data.ActivityMachine
import local.asb.companion.data.ActivityMessage
import local.asb.companion.data.ActivityMessages
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Seat
import local.asb.companion.data.SeatCount
import local.asb.companion.data.contrast
import local.asb.companion.data.ledger
import local.asb.companion.data.messageBucketPartial
import local.asb.companion.data.mixColor
import local.asb.companion.data.offlineBandColor
import local.asb.companion.ui.LabelOption
import local.asb.companion.ui.LabelTable
import local.asb.companion.ui.MESSAGES_EMPTY_HINT
import local.asb.companion.ui.PIN_RING
import local.asb.companion.ui.SeatLabelInput
import local.asb.companion.ui.dashedCircles
import local.asb.companion.ui.emptyBlockSizes
import local.asb.companion.ui.exitCircles
import local.asb.companion.ui.labelOptions
import local.asb.companion.ui.messageBucketTip
import local.asb.companion.ui.pinCircle
import local.asb.companion.ui.pixelCenter
import local.asb.companion.ui.placeSeatLabels
import local.asb.companion.ui.regionMachine
import local.asb.companion.ui.seatDirections
import local.asb.companion.ui.seatLabelPlace
import local.asb.companion.ui.seatLabelTexts
import local.asb.companion.ui.shareFill
import local.asb.companion.ui.shareWords
import local.asb.companion.ui.stripCaptionParts
import local.asb.companion.ui.stripFirstName
import local.asb.companion.ui.stripY
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The PC round 5 Messages changes (f9b56b4 and 6e68a1f), on the phone: M2, M3, M4, M6, M7, M12 with D14 A, M13, M14, M16, M17,
// M18, and the label order of repair 1.
class CouncilRoundFiveMessagesTest {
    private val center = Offset(200f, 200f)

    // ---------- Task 1: the strip line on device pixel centers over the zero baseline ----------

    @Test fun stripPointsSitOnPixelCentersOverTheZeroBaseline() {
        assertEquals(10.5f, pixelCenter(10.3f))
        assertEquals(10.5f, pixelCenter(10.99f))
        assertEquals(.5f, pixelCenter(0f))
        // The baseline is at the y of count 0: the bottom inset of the plot.
        assertEquals(66f - 8.25f, stripY(0, 9, 66f, 8.25f))
        assertEquals(8.25f, stripY(9, 9, 66f, 8.25f))
    }

    // ---------- Task 2: the current bucket ----------

    private val hour = 3_600_000L
    private val day = 86_400_000L

    private fun reply(unit: String, starts: List<Long>, now: Long, end: Long? = null): ActivityMessages =
        AsbJson.decodeFromString<ActivityMessages>(
            """{"nowMs":$now,"buckets":{"unit":"$unit","startsMs":[${starts.joinToString(",")}]${end?.let { ",\"endMs\":$it" } ?: ""}}}""")

    @Test fun theLastBucketIsPartialWhileItHoldsNow() {
        // Without endMs: an hour or a day after the last start.
        assertTrue(messageBucketPartial(reply("hour", listOf(0, hour), hour)))
        assertTrue(messageBucketPartial(reply("hour", listOf(0, hour), 2 * hour - 1)))
        assertFalse(messageBucketPartial(reply("hour", listOf(0, hour), 2 * hour)))
        assertFalse(messageBucketPartial(reply("hour", listOf(0, hour), hour - 1)))
        assertTrue(messageBucketPartial(reply("day", listOf(0, day), 2 * day - 1)))
        assertFalse(messageBucketPartial(reply("day", listOf(0, day), 2 * day)))
        // With endMs (a 23 hour day over a daylight saving change), the reply end decides.
        assertFalse(messageBucketPartial(reply("day", listOf(0, day), day + 23 * hour, end = day + 23 * hour)))
        assertTrue(messageBucketPartial(reply("day", listOf(0, day), day + 23 * hour - 1, end = day + 23 * hour)))
        assertEquals(day + 23 * hour, reply("day", listOf(0, day), 0, end = day + 23 * hour).buckets.endMs)
        assertNull(reply("day", listOf(0, day), 0).buckets.endMs)
        assertFalse(messageBucketPartial(reply("hour", emptyList(), 0)))
    }

    @Test fun theCurrentBucketTextSaysSoFar() = utc {
        assertEquals("16:00 so far: 4 messages", messageBucketTip(at("2026-10-26T16:00:00Z"), 4, 0, "hour", partial = true))
        assertEquals("Oct 26 so far: 27 messages, 1 not sent", messageBucketTip(at("2026-10-26T00:00:00Z"), 27, 1, "day", partial = true))
        assertEquals("Oct 26: 27 messages, 1 not sent", messageBucketTip(at("2026-10-26T00:00:00Z"), 27, 1, "day"))
    }

    // ---------- Task 4: the caption and the weekday ----------

    @Test fun theCaptionKeepsTwelveDpFromEachName() {
        // Names end at 40 and start at 300: 236 dp of room inside the 12 dp gaps.
        assertEquals(2, stripCaptionParts(40f, 300f, 50f, 186f, bad = true, dp = 1f))
        // The not-sent part goes first.
        assertEquals(1, stripCaptionParts(40f, 300f, 50f, 187f, bad = true, dp = 1f))
        assertEquals(1, stripCaptionParts(40f, 300f, 50f, 10f, bad = false, dp = 1f))
        // Then the whole caption.
        assertEquals(1, stripCaptionParts(40f, 114f, 50f, 10f, bad = false, dp = 1f))
        assertEquals(0, stripCaptionParts(40f, 113f, 50f, 10f, bad = true, dp = 1f))
        assertEquals(0, stripCaptionParts(40f, 137f, 50f, 10f, bad = false, dp = 2f))
    }

    @Test fun theFirstHourNameHasItsWeekdayOnAnEarlierDay() = utc {
        // 2026-11-08 is a Sunday.
        assertEquals("Sun 17:00", stripFirstName(at("2026-11-08T17:00:00Z"), at("2026-11-09T16:00:00Z"), "hour"))
        assertEquals("01:00", stripFirstName(at("2026-11-09T01:00:00Z"), at("2026-11-09T16:00:00Z"), "hour"))
        assertEquals("Oct 20", stripFirstName(at("2026-10-20T00:00:00Z"), at("2026-10-26T00:00:00Z"), "day"))
    }

    // ---------- Task 5: seat labels ----------

    @Test fun placesCountFromTheLargestPinRing() {
        val size = Size(40f, 14f)
        // Under: 3 dp past the 16 dp pin and its PIN_RING; the pin circle has the same reach (less the 0.5 tolerance).
        assertEquals(100f + 16 + PIN_RING + 3, seatLabelPlace(center, 100f, -90f, size, 1, 1f).y, .01f)
        assertEquals(100f + 19, seatLabelPlace(center, 100f, -90f, size, 1, 1f, ring = 0f).y, .01f)
        assertEquals(16 + PIN_RING - .5f, pinCircle(Offset.Zero, 1f).second)
        // Inward: PIN_RING farther in from the pin.
        assertEquals(seatLabelPlace(center, 100f, -90f, size, 0, 1f, ring = 0f).y + PIN_RING, seatLabelPlace(center, 100f, -90f, size, 0, 1f).y, .01f)
    }

    @Test fun aChosenSeatKeepsItsRestPlace() {
        // Inward and under are blocked: the label goes over its pin, at rest and when its seat is chosen.
        val seat = SeatLabelInput("a", -90f, listOf(Size(40f, 14f)), pin = pinCircle(Offset(200f, 100f), 1f))
        val table = LabelTable(center, 100f, 0f, false, 400f, 400f, listOf(Rect(150f, 120f, 250f, 160f)), pins = listOf(seat.pin!!))
        val rest = placeSeatLabels(listOf(seat), emptyList(), emptyMap(), emptyMap(), table, 1f).getValue("a")!!
        assertEquals(2, rest.place)
        assertEquals(rest, placeSeatLabels(listOf(seat), listOf("a"), emptyMap(), emptyMap(), table, 1f).getValue("a"))
        assertEquals(rest, placeSeatLabels(listOf(seat), listOf("a"), emptyMap(), emptyMap(), table, 1f, previous = mapOf("a" to rest)).getValue("a"))
    }

    @Test fun twoLineTextsNeedFourCharactersOnEachLine() {
        assertEquals(listOf("ui-polish", "ui-poli…"), seatLabelTexts("ui-polish"))
        assertEquals(listOf("docs-plan", "docs-\nplan", "docs-pl…"), seatLabelTexts("docs-plan"))
        assertEquals(listOf("render-ui", "render…"), seatLabelTexts("render-ui"))
    }

    private val line = { f: Float -> Offset(200f, 100f + 100f * f) }

    @Test fun exitsRunTwentyEightDpFromThePinRim() {
        val exits = exitCircles(100f, line, fromStart = true, restWidth = 8f, dp = 1f)
        assertEquals(8, exits.size)
        exits.forEachIndexed { i, (point, radius) ->
            assertEquals(Offset(200f, 116f + 4 * i).y, point.y, .001f)
            assertEquals(200f, point.x)
            assertEquals(6f, radius)
        }
        // The seat at the end of the chord: from that end, on a 2 dp screen.
        val far = exitCircles(200f, { f -> Offset(200f * f, 0f) }, fromStart = false, restWidth = 3f, dp = 2f)
        assertEquals(168f, far.first().first.x, .001f)
        assertEquals(112f, far.last().first.x, .001f)
        assertEquals(5.5f, far.first().second)
        // A short chord stops at its other end.
        assertEquals(120f, exitCircles(20f, { f -> Offset(200f, 100f + 20f * f) }, true, 2f, 1f).last().first.y, .001f)
        assertTrue(exitCircles(0f, line, true, 2f, 1f).isEmpty())
    }

    @Test fun dashedChordsAreCirclesAlongTheirWholeLength() {
        val circles = dashedCircles(10f, { f -> Offset(10f * f, 0f) }, 2f, 1f)
        assertEquals(4, circles.size)
        listOf(0f, 10f / 3, 20f / 3, 10f).zip(circles).forEach { (x, circle) -> assertEquals(x, circle.first.x, .001f) }
        assertTrue(circles.all { it.second == 4f })
        assertEquals(2, dashedCircles(3f, { f -> Offset(3f * f, 0f) }, 2f, 1f).size)
    }

    @Test fun labelsTryWholeTextsOffTheWidestExitsFirst() {
        val options = labelOptions(4, 2)
        assertEquals(4 * 9 * 3, options.size)
        // The whole texts: each text off all kept-off shapes, then off the widest exits; then each text with the widest exits.
        assertEquals(listOf(LabelOption(0, 0, 0), LabelOption(0, 8, 0), LabelOption(0, 0, 1), LabelOption(0, 8, 1),
            LabelOption(1, 0, 0), LabelOption(1, 8, 0), LabelOption(1, 0, 1), LabelOption(1, 8, 1),
            LabelOption(0, 0, 2), LabelOption(0, 8, 2), LabelOption(1, 0, 2), LabelOption(1, 8, 2)),
            options.take(54).filter { it.place == 0 || it.place == 8 })
        // Then the cut texts in the same order.
        assertEquals(LabelOption(2, 0, 0), options[54])
        assertEquals(LabelOption(3, 8, 2), options.last())
        // A chosen seat has only its whole texts.
        assertEquals(2 * 9 * 3, labelOptions(2, 2).size)
        assertEquals(LabelOption(0, 0, 2), labelOptions(1, 1)[18])
    }

    // A top seat (pin at 200, 100) with a 60 × 14 one-line text and a 34 × 28 two-line text. The holes leave the one-line text
    // only its inward box (169, 125) to (231, 139), and the two-line text only its right box (220, 86) to (256, 114).
    private val holes = listOf(Rect(0f, 0f, 400f, 85f), Rect(0f, 85f, 219f, 115f), Rect(257f, 85f, 400f, 115f), Rect(0f, 115f, 400f, 124f),
        Rect(0f, 124f, 168f, 140f), Rect(232f, 124f, 400f, 140f), Rect(0f, 140f, 400f, 400f))

    private fun topSeat(exits: List<Pair<Offset, Float>>, widest: List<Pair<Offset, Float>>, sizes: List<Size> = listOf(Size(60f, 14f), Size(34f, 28f))) =
        placeSeatLabels(listOf(SeatLabelInput("s", -90f, sizes, whole = 2, exits = exits, widest = widest)), emptyList(), emptyMap(), emptyMap(),
            LabelTable(center, 100f, 0f, false, 400f, 400f, holes), 1f).getValue("s")!!.let { it.text to it.place }

    @Test fun aLabelOnItsWidestExitTakesItsTwoLineTextOffIt() {
        // The chord runs straight down from the pin: its exits cross the inward box.
        val exits = exitCircles(100f, line, fromStart = true, restWidth = 8f, dp = 1f)
        assertEquals(0 to 0, topSeat(emptyList(), emptyList()))
        assertEquals(1 to 4, topSeat(exits, exits))
        // An exit of a narrower chord only: the one-line text keeps its inward place.
        assertEquals(0 to 0, topSeat(exits, emptyList()))
        // With no place off the widest exit, the one-line text takes its inward place on it.
        assertEquals(0 to 0, topSeat(exits, exits, listOf(Size(60f, 14f), Size(60f, 28f))))
    }

    @Test fun dashedChordsAreKeptOffForEveryLabel() {
        // A dashed chord point inside the inward box: the label takes the next place that touches none.
        val seat = SeatLabelInput("s", -90f, listOf(Size(40f, 14f)))
        val open = LabelTable(center, 100f, 0f, false, 400f, 400f, emptyList())
        val dashed = LabelTable(center, 100f, 0f, false, 400f, 400f, emptyList(), dashed = listOf(Offset(200f, 138f) to 1f))
        assertEquals(0, placeSeatLabels(listOf(seat), emptyList(), emptyMap(), emptyMap(), open, 1f).getValue("s")!!.place)
        assertEquals(1, placeSeatLabels(listOf(seat), emptyList(), emptyMap(), emptyMap(), dashed, 1f).getValue("s")!!.place)
    }

    @Test fun theLastPassPlacesFromThePinItself() {
        // Only the inward box of a ring-free place is open: (179, 123) to (221, 137).
        val hole = listOf(Rect(0f, 0f, 400f, 122f), Rect(0f, 138f, 400f, 400f), Rect(0f, 122f, 178f, 138f), Rect(222f, 122f, 400f, 138f))
        val a = SeatLabelInput("a", -90f, listOf(Size(40f, 14f)), pin = pinCircle(Offset(200f, 100f), 1f))
        val b = SeatLabelInput("b", 90f, listOf(Size(40f, 14f)), pin = pinCircle(Offset(260f, 130f), 1f))
        val table = LabelTable(center, 100f, 0f, false, 400f, 400f, hole, pins = listOf(a.pin!!, b.pin!!))
        val spot = placeSeatLabels(listOf(a, b), emptyList(), mapOf("a" to 2), emptyMap(), table, 1f).getValue("a")!!
        assertEquals(0, spot.place)
        assertEquals(123f, spot.box.top, .01f)
        // The pin circles count at 16 dp there: a pin whose ring-free circle touches the box still blocks it.
        val near = SeatLabelInput("b", 90f, listOf(Size(40f, 14f)), pin = pinCircle(Offset(236f, 130f), 1f))
        val crowded = LabelTable(center, 100f, 0f, false, 400f, 400f, hole, pins = listOf(a.pin, near.pin!!))
        assertNull(placeSeatLabels(listOf(a, near), emptyList(), mapOf("a" to 2), emptyMap(), crowded, 1f).getValue("a"))
    }

    // ---------- Task 6: halos ----------

    @Test fun haloFillsFollowTheRegionUnderTheLabel() {
        val arcs = mapOf("desk" to (-90f to 90f), "laptop" to (170f to 200f))
        assertEquals("desk", regionMachine(Offset(260f, 200f), center, 40f, 100f, arcs))
        // The center disc, the band, and the background have no sector tint.
        assertNull(regionMachine(Offset(230f, 200f), center, 40f, 100f, arcs))
        assertNull(regionMachine(Offset(310f, 200f), center, 40f, 100f, arcs))
        assertNull(regionMachine(Offset(200f, 140f), center, 40f, 100f, mapOf("desk" to (0f to 90f))))
        // A sector across 180°: -175° is inside 170° to 200°.
        assertEquals("laptop", regionMachine(center + Offset(-60f, -5f), center, 40f, 100f, arcs))
        // A small table draws no disc: its center belongs to the sector.
        assertEquals("desk", regionMachine(Offset(210f, 200f), center, 0f, 100f, arcs))
    }

    // ---------- Task 7: the offline band ----------

    @Test fun theOfflineBandKeepsThreeToOneOnTheBackground() {
        // 45% of the hue has less than 3:1 on #222226: the hue goes up to 60%.
        assertEquals("#7b6584", offlineBandColor("#222226", "#b692c3"))
        assertTrue(contrast("#7b6584", "#222226") >= 3)
        assertTrue(contrast(mixColor("#222226", "#b692c3", .59), "#222226") < 3)
        // 45% is enough: the band stays 55% toward the background.
        assertEquals(mixColor("#000000", "#ffffff", .45), offlineBandColor("#000000", "#ffffff"))
        // No mix reaches 3:1: the hue itself.
        assertEquals("#d6a15e", offlineBandColor("#ffffff", "#d6a15e"))
    }

    // ---------- Task 8: share bars ----------

    private fun message(id: String, from: String, to: String) = ActivityMessage(id, from, to, 1L)

    @Test fun shareBarsFillTheirCountOverAllMessages() {
        assertEquals(19f / 65, shareFill(19, 65))
        assertEquals(0f, shareFill(3, 0))
        assertEquals("29.2% of all messages", shareWords(shareFill(19, 65)))
        // Made-up machines and seats: the Between machines fills add up to one full track.
        val seats = listOf(Seat("a", "alpha", "codex", "m1"), Seat("b", "beta", "claude", "m2"), Seat("c", "gamma", "codex", "m1"),
            Seat("d", "delta", "opencode", "m3"))
        val pairs = List(19) { "a" to "b" } + List(30) { "a" to "c" } + List(10) { "b" to "d" } + List(6) { "d" to "d" }
        val reply = ActivityMessages(machines = listOf(ActivityMachine("m1", "Desk"), ActivityMachine("m2", "Laptop"), ActivityMachine("m3", "Studio")),
            seats = seats, messages = pairs.mapIndexed { i, (from, to) -> message("$i", from, to) })
        val ledger = ledger(reply)
        assertEquals(65, ledger.total)
        assertEquals(4, ledger.machineRows.size)
        assertEquals(1f, ledger.machineRows.map { shareFill(it.count, ledger.total) }.sum(), 1e-6f)
        assertTrue(ledger.machineRows.any { shareFill(it.count, ledger.total) == 19f / 65 })
    }

    // ---------- Tasks 9 and 10: direction words and the empty block ----------

    @Test fun seatsSayOutgoingAndIncoming() {
        assertEquals("10 outgoing, 8 incoming", seatDirections(SeatCount(sent = 10, received = 8)))
        assertEquals("0 outgoing, 0 incoming", seatDirections(null))
    }

    @Test fun theEmptyBlockGrowsWithTheDisc() {
        assertEquals("When an agent sends a message to another session with ASB Bridge, it shows here.", MESSAGES_EMPTY_HINT)
        assertEquals(96 to 20, emptyBlockSizes(519.9f))
        assertEquals(128 to 26, emptyBlockSizes(520f))
    }

    private fun utc(body: () -> Unit) {
        val zone = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
        try { body() } finally { TimeZone.setDefault(zone) }
    }

    private fun at(text: String) = java.time.Instant.parse(text).toEpochMilli()
}
