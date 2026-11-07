package local.asb.companion

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import java.util.TimeZone
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import local.asb.companion.data.APP_COLORS
import local.asb.companion.data.ActivityMachine
import local.asb.companion.data.ActivityMessage
import local.asb.companion.data.ActivityMessages
import local.asb.companion.data.AsbJson
import local.asb.companion.data.BusyPair
import local.asb.companion.data.MACHINE_HUES
import local.asb.companion.data.Metric
import local.asb.companion.data.Palette
import local.asb.companion.data.STATUS_COLORS
import local.asb.companion.data.Seat
import local.asb.companion.data.UsageRow
import local.asb.companion.data.accentGuard
import local.asb.companion.data.busiestPairs
import local.asb.companion.data.contrast
import local.asb.companion.data.contrastFloor
import local.asb.companion.data.messageStatusLabel
import local.asb.companion.data.notSentCounts
import local.asb.companion.data.seatTitles
import local.asb.companion.data.statusTextOn
import local.asb.companion.data.unlistedName
import local.asb.companion.ui.LabelTable
import local.asb.companion.ui.SeatLabelInput
import local.asb.companion.ui.activityColorsOf
import local.asb.companion.ui.appSplit
import local.asb.companion.ui.endCircle
import local.asb.companion.ui.pinCircle
import local.asb.companion.ui.axisLabels
import local.asb.companion.ui.factLines
import local.asb.companion.ui.hex
import local.asb.companion.ui.machineStateLine
import local.asb.companion.ui.notSentEndSpan
import local.asb.companion.ui.placeSeatLabels
import local.asb.companion.ui.seatLabelPlace
import local.asb.companion.ui.tipOrder
import local.asb.companion.ui.tooltipTitle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The PC values of the Messages and Usage council round 3 (scripts/asb-native.py at 7aa7bdd, 02f9c35, and 15d8313).
class CouncilRoundThreeTest {
    // ---------- Messages ----------

    @Test fun notSentEndsStartAtThePinRim() {
        // 15% of a 400 px chord, from 16 px before the receiver pin.
        assertEquals(384f to 324f, notSentEndSpan(400f, 1f, forward = true))
        assertEquals(16f to 76f, notSentEndSpan(400f, 1f, forward = false))
        // At least 24 dp, at most half of the chord.
        assertEquals(84f to 60f, notSentEndSpan(100f, 1f, forward = true))
        assertEquals(32f to 80f, notSentEndSpan(200f, 2f, forward = false))
        assertEquals(24f to 4f, notSentEndSpan(40f, 1f, forward = true))
    }

    private val center = Offset(200f, 200f)

    @Test fun ninePlacesAroundThePin() {
        val size = Size(40f, 14f)
        val d = .707f * 19f
        // The four diagonals put the label corner nearest the pin at 45° and the gap of places 1 to 4.
        val expected = mapOf(5 to Offset(200f + d, 100f + d), 6 to Offset(200f - d - 40f, 100f + d),
            7 to Offset(200f + d, 100f - d - 14f), 8 to Offset(200f - d - 40f, 100f - d - 14f))
        for ((place, at) in expected) {
            val got = seatLabelPlace(center, 100f, -90f, size, place, 1f)
            assertEquals(at.x, got.x, .01f)
            assertEquals(at.y, got.y, .01f)
        }
    }

    private val sizes = listOf(Size(120f, 14f), Size(60f, 14f), Size(40f, 14f))

    @Test fun labelsTryTheDiagonalsBeforeACut() {
        // Inward, under, over, left, and right are blocked for the whole text; a right diagonal is free, so the whole text takes it.
        val top = SeatLabelInput("top", -90f, sizes)
        val blocked = listOf(Rect(0f, 0f, 205f, 400f), Rect(205f, 92f, 400f, 108f))
        val spot = placeSeatLabels(listOf(top), emptyList(), emptyMap(), emptyMap(), LabelTable(center, 100f, 0f, false, 400f, 400f, blocked), 1f)
            .getValue("top")!!
        assertEquals(0, spot.text)
        assertTrue(spot.place == 5 || spot.place == 7)
    }

    @Test fun pinsAreCirclesForLabels() {
        // The whole text takes the under-right diagonal (place 5); a pin 18 dp from its nearest corner leaves it free, 16 dp blocks it.
        val top = SeatLabelInput("top", -90f, sizes)
        val rects = listOf(Rect(0f, 0f, 205f, 400f), Rect(205f, 92f, 400f, 108f))
        val place = { circles: List<Pair<Offset, Float>> ->
            placeSeatLabels(listOf(top), emptyList(), emptyMap(), emptyMap(),
                LabelTable(center, 100f, 0f, false, 400f, 400f, rects, circles = circles), 1f).getValue("top")!!
        }
        val free = place(emptyList())
        assertEquals(5, free.place)
        val corner = Offset(free.box.left, free.box.top)
        val away = { distance: Float -> corner - Offset(distance, distance) / Math.sqrt(2.0).toFloat() }
        assertEquals(16.5f, pinCircle(Offset.Zero, 1f).second)
        assertEquals(5, place(listOf(pinCircle(away(18f), 1f))).place)
        assertTrue(place(listOf(pinCircle(away(16f), 1f))).place != 5)
    }

    @Test fun notSentEndPointsAreCirclesForLabels() {
        // An end point endWidth / 2 + 1.5 dp left of the inward box leaves it free; at endWidth / 2 + 0.5 dp it blocks it.
        val seat = SeatLabelInput("s", -90f, listOf(Size(40f, 14f)))
        val endWidth = 3f
        val place = { circles: List<Pair<Offset, Float>> ->
            placeSeatLabels(listOf(seat), emptyList(), emptyMap(), emptyMap(),
                LabelTable(center, 100f, 0f, false, 400f, 400f, emptyList(), circles = circles), 1f).getValue("s")!!
        }
        val free = place(emptyList())
        assertEquals(0, free.place)
        val beside = { distance: Float -> Offset(free.box.left - distance, (free.box.top + free.box.bottom) / 2) }
        assertEquals(0, place(listOf(endCircle(beside(endWidth / 2 + 1.5f), endWidth, 1f))).place)
        assertTrue(place(listOf(endCircle(beside(endWidth / 2 + .5f), endWidth, 1f))).place != 0)
    }

    @Test fun labelsKeepOffTheMachineBand() {
        // A pin 30 dp inside the band with inward and under blocked: over would reach the band, so the label goes left.
        val seat = SeatLabelInput("s", -90f, listOf(Size(40f, 14f)))
        val blocked = listOf(Rect(170f, 75f, 230f, 100f))
        val place = { ri: Float, ro: Float ->
            placeSeatLabels(listOf(seat), emptyList(), emptyMap(), emptyMap(), LabelTable(center, 140f, 0f, false, 400f, 400f, blocked, ri, ro), 1f)
                .getValue("s")!!.place
        }
        assertEquals(2, place(Float.MAX_VALUE, Float.MAX_VALUE))
        assertEquals(3, place(170f, 180f))
    }

    @Test fun placedLabelsKeepSixDpAtTheirSides() {
        // b's inward place starts 2.5 dp right of a's inward box, at the same height: inside a's 6 dp side room.
        val a = SeatLabelInput("a", -90f, listOf(Size(40f, 14f)))
        val b = SeatLabelInput("b", -60.3f, listOf(Size(40f, 14f)))
        val table = LabelTable(center, 121f, 0f, false, 400f, 400f, emptyList())
        val alone = placeSeatLabels(listOf(b), emptyList(), emptyMap(), emptyMap(), table, 1f).getValue("b")!!
        val spots = placeSeatLabels(listOf(a, b), emptyList(), mapOf("a" to 2), emptyMap(), table, 1f)
        val boxA = spots.getValue("a")!!.box
        assertEquals(0, spots.getValue("a")!!.place)
        assertEquals(0, alone.place)
        assertFalse(alone.box.overlaps(boxA))
        assertTrue(alone.box.left - boxA.right in 2f..3f)
        assertTrue(spots.getValue("b")!!.place != 0)
    }

    @Test fun partnersPlaceAfterTheSelectedSeat() {
        val seats = listOf("a", "b", "c", "d").mapIndexed { i, id -> SeatLabelInput(id, -90f + 90f * i, sizes) }
        val table = LabelTable(center, 100f, 40f, true, 400f, 400f, emptyList())
        val order = placeSeatLabels(seats, listOf("d"), mapOf("a" to 9, "b" to 1, "c" to 5), emptyMap(), table, 1f, setOf("b", "c")).keys
        assertEquals(listOf("d", "c", "b", "a"), order.toList())
    }

    private fun message(id: String, from: String, to: String, at: Long, status: String = "accepted", fromLabel: String = "",
        toLabel: String = "", reason: String = "") = ActivityMessage(id, from, to, at, status, reason, fromLabel = fromLabel, toLabel = toLabel)

    @Test fun unlistedSeatsAreNamedFromTheirMessages() {
        assertEquals("Unlisted sessions", unlistedName(emptyList()))
        assertEquals("release-plan", unlistedName(listOf("release-plan")))
        assertEquals("2 unlisted sessions", unlistedName(listOf("a", "b")))
        val reply = ActivityMessages(seats = listOf(Seat("unknown:m1", "Other sessions"), Seat("unknown:m2"), Seat("unknown:m3"), Seat("s1", "Card"),
            Seat("s2")), messages = listOf(
            message("1", "unknown:m1", "s1", 1, fromLabel = "x"), message("2", "s1", "unknown:m1", 2, toLabel = "x"),
            message("3", "unknown:m2", "s1", 3, fromLabel = "p"), message("4", "s1", "unknown:m2", 4, toLabel = "q")))
        assertEquals(mapOf("unknown:m1" to "x", "unknown:m2" to "2 unlisted sessions", "unknown:m3" to "Unlisted sessions",
            "s1" to "Card", "s2" to "Unlisted sessions"), seatTitles(reply))
        // The phone reply carries the labels.
        assertEquals("y", AsbJson.decodeFromString<ActivityMessage>("""{"id":"1","fromLabel":"x","toLabel":"y"}""").toLabel)
    }

    @Test fun notSentStatusNamesItsReasonAndCountsBothEnds() {
        assertEquals("Not sent · Machine offline", messageStatusLabel(message("1", "a", "b", 1, "not-sent", reason = "Machine offline")))
        assertEquals("Not sent", messageStatusLabel(message("1", "a", "b", 1, "not-sent")))
        assertEquals("On hold", messageStatusLabel(message("1", "a", "b", 1, "held", reason = "x")))
        val counts = notSentCounts(listOf(message("1", "a", "b", 1, "not-sent"), message("2", "b", "a", 2, "not-sent"),
            message("3", "a", "c", 3)))
        assertEquals(mapOf("a" to 2, "b" to 2), counts)
    }

    @Test fun statusWordsHaveFourAndAHalfToOne() {
        assertEquals("#c47365", statusTextOn("#b56658", "#222226", "#ffffff"))
        assertEquals("#c47465", statusTextOn("#ad5f51", "#222226", "#ffffff"))
        assertEquals("#71777f", statusTextOn("#8c929a", "#ffffff", "#000000"))
        assertEquals("#f5a090", statusTextOn("#f5a090", "#222226", "#ffffff"))
        val red = activityColorsOf(Palette(background = "#222226", text = "#ffffff", accent = "#ff888c"))
        // The swatch keeps its guarded color; the word gets 4.5:1.
        assertEquals("#ad5f51", red.status.getValue("not-sent").hex())
        assertEquals("#c47465", red.statusWords.getValue("not-sent").hex())
        for (color in red.statusWords.values) assertTrue(contrast(color.hex(), "#222226") >= 4.5)
    }

    @Test fun busiestPairsRankByCountThenNewestThenCircle() {
        val reply = ActivityMessages(
            machines = listOf(ActivityMachine("m1")),
            seats = listOf("a", "b", "c", "d", "e", "f", "g").mapIndexed { i, id -> Seat(id, id, "codex", "m1", i) },
            messages = listOf(
                message("1", "a", "b", 1), message("2", "b", "a", 2, "not-sent"), message("3", "b", "a", 3),
                message("4", "c", "d", 4), message("5", "d", "c", 9),
                message("6", "e", "f", 5), message("7", "f", "e", 9),
                message("8", "a", "a", 10), message("9", "a", "a", 11), message("10", "a", "a", 12), message("11", "a", "a", 13),
                message("12", "g", "a", 6), message("13", "g", "b", 7), message("14", "x", "g", 8)))
        val pairs = busiestPairs(reply)
        // c|d and e|f tie on count and newest message: circle order decides. A session to itself does not count.
        assertEquals(listOf("a|b", "c|d", "e|f", "g|x", "b|g"), pairs.map { it.key })
        assertEquals(BusyPair("a", "b", 3, 1, 3), pairs[0])
        assertEquals(1, busiestPairs(reply, 1).size)
        assertEquals(emptyList<BusyPair>(), busiestPairs(ActivityMessages()))
        // An unseated session counts too.
        assertEquals(BusyPair("g", "x", 1, 0, 8), pairs[3])
    }

    // ---------- Usage ----------

    private fun utc(body: () -> Unit) {
        val zone = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
        try { body() } finally { TimeZone.setDefault(zone) }
    }

    private fun at(text: String) = java.time.Instant.parse(text).toEpochMilli()

    @Test fun theLastTickNamesItsBucket() = utc {
        val measure = { text: String -> 7f * text.length }
        val days = List(7) { at("2026-10-25T00:00:00Z") + it * 86_400_000L }
        assertEquals("Oct 31", axisLabels(days, "day", List(7) { 60f + it * 130f }, 1000f, 4f, measure).last().text)
        val hours = List(24) { at("2026-10-24T00:00:00Z") + it * 3_600_000L }
        assertEquals("23:00", axisLabels(hours, "hour", List(24) { 60f + it * 39f }, 1000f, 4f, measure).last().text)
        val months = List(3) { at(java.time.YearMonth.parse("2026-09").plusMonths(it.toLong()).atDay(1).toString() + "T00:00:00Z") }
        assertEquals(listOf("Sep 2026", "Oct", "Nov"), axisLabels(months, "month", List(3) { 100f + it * 400f }, 1000f, 4f, measure).map { it.text })
        assertEquals("October 2026 · so far", tooltipTitle(at("2026-10-01T00:00:00Z"), "month", last = true))
        assertEquals("Oct 31", tooltipTitle(days.last(), "day", last = false))
    }

    @Test fun tooltipSeriesGoHighToLow() {
        assertEquals(listOf(1, 0, 3, 2), tipOrder(listOf(2.0, 5.0, 0.0, 1.0)))
        // Ties keep the series order.
        assertEquals(listOf(1, 0, 2), tipOrder(listOf(1.0, 3.0, 1.0)))
    }

    @Test fun machineStateBreaksOnlyBetweenFacts() = utc {
        val line = machineStateLine(ActivityMachine(state = "offline", lastReportAtMs = at("2026-10-25T14:30:00Z")))
        val measure = { text: String -> 6f * text.length }
        // Wide: one line. Narrow: a break between the facts drops the ` · `, and the date keeps no-break spaces.
        assertEquals(listOf("Offline · seen Oct 25, 14:30"), factLines(line, 1000f, measure))
        assertEquals(listOf("Offline", "seen Oct 25, 14:30"), factLines(line, 112f, measure))
        // A fact wider than the column stays on its own line, for the text to break inside.
        assertEquals(listOf("Offline", "seen Oct 25, 14:30"), factLines(line, 50f, measure))
        assertEquals(listOf("Connected"), factLines("Connected", 10f, measure))
        assertFalse(factLines(line, 112f, measure).any { it.endsWith("·") || it.startsWith("·") })
    }

    @Test fun machineRowsSpeakTheirAppSplit() {
        val row = UsageRow("m1", 7218.47, 1.0, listOf("codex" to 2112.17, "claude" to 4854.0, "opencode" to 252.30, "" to 0.0))
        assertEquals("Codex $2,112.17, Claude Code $4,854.00, OpenCode $252.30", appSplit(row, Metric.COST))
        assertEquals("Codex 1.2M", appSplit(UsageRow("m1", 1.2e6, 1.0, listOf("codex" to 1.2e6, "claude" to 0.0)), Metric.TOKENS))
    }

    @Test fun accentGuardMatchesThePcTable() {
        val rows = Json.parseToJsonElement(javaClass.getResource("/accent-guard.json")!!.readText()) as JsonArray
        assertEquals(12 * (APP_COLORS.size + STATUS_COLORS.size + MACHINE_HUES.size), rows.size)
        val moved = mutableSetOf<String>()
        for (row in rows) {
            val r = row.jsonObject.mapValues { it.value.jsonPrimitive.content }
            assertEquals(r.toString(), r.getValue("guarded"), accentGuard(r.getValue("color"), r.getValue("accent"), r.getValue("background")))
            if (r["color"] != r["guarded"]) moved += "${r["accent"]} ${r["key"]} ${r["guarded"]}"
        }
        // Slate Codex and Accepted, orange Not sent, and red Not sent.
        assertTrue(moved.toString(), moved.containsAll(listOf("#bbd1e5 codex #b0b3b7", "#bbd1e5 accepted #b0b3b7", "#ff9c5b not-sent #b56658",
            "#ff888c not-sent #ad5f51")))
        // The screens use the same values, with Unknown and Other after their floor.
        val slate = activityColorsOf(Palette(background = "#222226", text = "#ffffff", accent = "#bbd1e5"))
        assertEquals("#b0b3b7", slate.apps.getValue("codex").hex())
        assertEquals("#b0b3b7", slate.status.getValue("accepted").hex())
        val floor = contrastFloor("#5d6268", "#ffffff", "#222226", 3.0)
        assertEquals(accentGuard(floor, "#bbd1e5", "#222226"), slate.status.getValue("unknown").hex())
    }
}
