package local.asb.companion

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import local.asb.companion.data.APP_COLORS
import local.asb.companion.data.MACHINE_HUES
import local.asb.companion.data.Palette
import local.asb.companion.data.STATUS_COLORS
import local.asb.companion.data.STATUS_ORDER
import local.asb.companion.data.STATUS_TIPS
import local.asb.companion.data.accentGuard
import local.asb.companion.data.contrast
import local.asb.companion.data.contrastFloor
import local.asb.companion.data.statusLabel
import local.asb.companion.data.usageRingNote
import local.asb.companion.data.usageTokenRamp
import local.asb.companion.ui.LabelTable
import local.asb.companion.ui.SeatLabelInput
import local.asb.companion.ui.activityColorsOf
import local.asb.companion.ui.hex
import local.asb.companion.ui.placeSeatLabels
import local.asb.companion.ui.seatLabelPlace
import local.asb.companion.ui.seatLabelTexts
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The PC values of the Messages and Usage council round 2 (scripts/asb-native.py).
class CouncilRoundTwoTest {
    @Test fun statusNamesArePlain() {
        assertEquals(listOf("Accepted", "No receipt", "On hold", "Not sent", "Status unknown"), STATUS_ORDER.map(::statusLabel))
        assertEquals("Status unknown", statusLabel("lost"))
        // The meanings keep their words.
        assertEquals("ASB wrote the message to the receiver. No receipt came back.", STATUS_TIPS.getValue("written"))
    }

    @Test fun accentGuardMovesOnlyColorsNearTheAccent() {
        assertEquals("#ac8220", accentGuard("#e0b45a", "#ffb900", "#000000"))
        assertEquals("#b27f3b", accentGuard("#d6a15e", "#ffb900", "#000000"))
        assertEquals("#928d05", accentGuard("#e8e46a", "#ffb900", "#000000"))
        assertEquals("#feccc2", accentGuard("#f5a090", "#e8794f", "#222226"))
        assertEquals("#ffcdbd", accentGuard("#d97757", "#e8794f", "#222226"))
        for ((accent, background) in listOf("#81d0ff" to "#222226", "#7cc4ff" to "#10141c")) {
            val floor = contrastFloor(APP_COLORS.getValue(""), "#ffffff", background, 3.0)
            for (color in STATUS_COLORS.values + APP_COLORS.values + MACHINE_HUES + floor) {
                assertEquals(color, accentGuard(color, accent, background))
            }
        }
    }

    @Test fun guardedColorsKeepTheirContrast() {
        val guarded = accentGuard("#e0b45a", "#ffb900", "#000000")
        assertTrue(contrast(guarded, "#ffb900") >= 2)
        assertTrue(contrast(guarded, "#000000") >= 3)
    }

    @Test fun screensUseTheGuardedColors() {
        val colors = activityColorsOf(Palette(background = "#000000", text = "#ffffff", accent = "#ffb900"))
        assertEquals("#ac8220", colors.status.getValue("held").hex())
        assertEquals("#ac8220", colors.statusText.getValue("held").hex())
        assertEquals("#928d05", colors.apps.getValue("grok").hex())
        assertEquals("#b27f3b", colors.hue(3).hex())
        assertEquals(colors.hue(0), colors.hue(MACHINE_HUES.size))
        val blue = activityColorsOf(Palette(background = "#222226", text = "#ffffff", accent = "#81d0ff"))
        assertEquals(STATUS_COLORS.getValue("not-sent"), blue.status.getValue("not-sent").hex())
        assertEquals("#959ba3", blue.statusText.getValue("written").hex())
        assertEquals(contrastFloor("#5d6268", "#ffffff", "#222226", 3.0), blue.status.getValue("unknown").hex())
        assertEquals(contrastFloor("#5d6268", "#ffffff", "#222226", 3.0), blue.apps.getValue("").hex())
    }

    @Test fun tokenRampHasEvenSteps() {
        val keys = listOf("cacheRead", "cacheWrite", "uncached", "output")
        val ramp = { accent: String, background: String -> usageTokenRamp(accent, background).let { r -> keys.map { r.getValue(it) } } }
        // Round 4: each step's chroma scales with its lightness.
        assertEquals(listOf("#765400", "#a27400", "#cf9600", "#ffb900"), ramp("#ffb900", "#000000"))
        assertEquals(listOf("#44728d", "#5890b2", "#6cafd8", "#81d0ff"), ramp("#81d0ff", "#222226"))
        assertEquals(listOf("#3e6687", "#5284ad", "#67a3d5", "#7cc4ff"), ramp("#7cc4ff", "#10141c"))
    }

    @Test fun ringNoteBreaksOnlyBetweenParts() {
        assertEquals("still\u00a0reading · 2\u00a0of\u00a03\u00a0machines · without\u00a01\u00a0unpriced\u00a0model",
            usageRingNote(true, 2, 3, true, 10, 1))
        assertEquals("without\u00a03\u00a0unpriced\u00a0models", usageRingNote(false, 3, 3, true, 10, 3))
        assertEquals("", usageRingNote(false, 3, 3, false, 10, 1))
    }

    @Test fun seatLabelTextsCutTo24Then10Then7() {
        assertEquals(listOf("Short"), seatLabelTexts("Short"))
        assertEquals(listOf("Nine char", "Nine ch…"), seatLabelTexts("Nine char"))
        assertEquals(listOf("Twelve chars", "Twelve cha…", "Twelve …"), seatLabelTexts("Twelve chars"))
        val long = "A title that is longer than 24 characters"
        assertEquals(listOf(long.take(24) + "…", long.take(10) + "…", long.take(7) + "…"), seatLabelTexts(long))
    }

    private val center = Offset(200f, 200f)

    @Test fun fivePlacesAroundThePin() {
        val size = Size(40f, 14f)
        val expected = listOf(Offset(180f, 123f), Offset(180f, 119f), Offset(180f, 67f), Offset(141f, 93f), Offset(219f, 93f))
        for (place in 0..4) {
            val at = seatLabelPlace(center, 100f, -90f, size, place, 1f)
            assertEquals(expected[place].x, at.x, .01f)
            assertEquals(expected[place].y, at.y, .01f)
        }
        // On a 2 dp screen the near edge is (16 + 3) × 2 px from the pin center.
        assertEquals(100f + 38f, seatLabelPlace(center, 100f, -90f, size, 1, 2f).y, .01f)
    }

    private fun table(blocked: List<Rect> = emptyList()) = LabelTable(center, 100f, 40f, true, 400f, 400f, blocked)
    private val sizes = listOf(Size(120f, 14f), Size(60f, 14f), Size(40f, 14f))
    private val top = SeatLabelInput("top", -90f, sizes)
    private fun place(blocked: List<Rect>, chosen: List<String> = emptyList()) =
        placeSeatLabels(listOf(top), chosen, emptyMap(), emptyMap(), table(blocked), 1f)["top"]

    @Test fun labelsTakeTheFirstFreePlace() {
        val spot = place(emptyList())!!
        assertEquals(0 to 0, spot.text to spot.place)
        assertEquals(Rect(139f, 123f, 261f, 137f).toString(), spot.box.let { Rect(Math.round(it.left).toFloat(), Math.round(it.top).toFloat(),
            Math.round(it.right).toFloat(), Math.round(it.bottom).toFloat()) }.toString())
        // With inward blocked, the label goes under the pin.
        assertEquals(0 to 1, place(listOf(Rect(130f, 134f, 270f, 140f)))!!.let { it.text to it.place })
    }

    @Test fun labelsCutWhenTheWholeTextFindsNoPlace() {
        assertEquals(1 to 0, place(listOf(Rect(0f, 0f, 165f, 400f), Rect(235f, 0f, 400f, 400f)))!!.let { it.text to it.place })
        assertEquals(2 to 0, place(listOf(Rect(0f, 0f, 175f, 400f), Rect(225f, 0f, 400f, 400f)))!!.let { it.text to it.place })
        // Nothing free: the label hides, but a chosen seat shows its whole label inward.
        val all = listOf(Rect(0f, 0f, 400f, 400f))
        assertNull(place(all))
        assertEquals(0 to 0, place(all, listOf("top"))!!.let { it.text to it.place })
    }

    @Test fun labelsStayInsideAndOffTheDisc() {
        // A seat at the bottom whose inward place would touch the center disc takes another place.
        val low = SeatLabelInput("low", 90f, listOf(Size(120f, 14f)))
        val spot = placeSeatLabels(listOf(low), emptyList(), emptyMap(), emptyMap(), LabelTable(center, 75f, 40f, true, 400f, 400f, emptyList()), 1f)["low"]!!
        assertTrue(spot.place > 0)
        assertTrue(spot.box.left >= 2 && spot.box.right <= 398 && spot.box.bottom <= 398)
    }

    @Test fun labelsPlaceChosenThenByCountThenNewestThenCircle() {
        val seats = listOf("a", "b", "c", "d", "e").mapIndexed { i, id -> SeatLabelInput(id, -90f + 72f * i, sizes) }
        val order = placeSeatLabels(seats, listOf("e", "d"), mapOf("b" to 3, "c" to 3, "a" to 1), mapOf("c" to 20L, "b" to 10L),
            table(), 1f).keys.toList()
        assertEquals(listOf("e", "d", "c", "b", "a"), order)
        assertEquals(listOf("a", "b", "c", "d", "e"), placeSeatLabels(seats, emptyList(), emptyMap(), emptyMap(), table(), 1f).keys.toList())
    }

    @Test fun placedLabelsAvoidEachOther() {
        // Two seats at one angle: the second label cannot take the first one's place.
        val seats = listOf(SeatLabelInput("a", -90f, sizes), SeatLabelInput("b", -90f, sizes))
        val spots = placeSeatLabels(seats, emptyList(), mapOf("a" to 2), emptyMap(), table(), 1f)
        assertEquals(0, spots.getValue("a")!!.place)
        assertTrue(spots.getValue("b")!!.place > 0)
        assertFalse(spots.getValue("a")!!.box.overlaps(spots.getValue("b")!!.box))
    }
}
