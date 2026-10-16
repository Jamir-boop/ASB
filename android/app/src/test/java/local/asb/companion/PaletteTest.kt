package local.asb.companion

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Dashboard
import local.asb.companion.data.Palette
import local.asb.companion.data.contrast
import local.asb.companion.data.displaySourceColor
import local.asb.companion.data.edgeColor
import local.asb.companion.data.highlightColor
import local.asb.companion.data.limitedColor
import local.asb.companion.data.luminance
import local.asb.companion.data.mixColor
import local.asb.companion.data.quietColor
import local.asb.companion.data.readableColor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Expected values come from the functions in scripts/asb-native.py, run with python3.
// Java pow can differ from C pow in the last bit, so luminance and contrast use a small tolerance.
class PaletteTest {
    private val custom = Palette("custom", "#101418", "#e8e4dc", "#f0b45a", "#a8a29a", "#3a3f46", "#f0b45a", "#f0b45a")

    @Test fun colorMathMatchesPython() {
        assertEquals(0.016240767445610593, luminance("#222226"), 1e-12)
        assertEquals(1.0, luminance("#ffffff"), 1e-12)
        assertEquals(0.006764186855149686, luminance("#101418"), 1e-12)
        assertEquals(0.7780991712576721, luminance("#e8e4dc"), 1e-12)
        assertEquals(15.851265625238128, contrast("#ffffff", "#222226"), 1e-12)
        assertEquals(6.850705367397503, contrast("#222226", "#78aeed"), 1e-12)
        assertEquals(14.588408944724387, contrast("#e8e4dc", "#101418"), 1e-12)
        assertEquals(10.024976978906995, contrast("#f0b45a", "#101418"), 1e-12)
        assertEquals("#c1c1c2", mixColor("#222226", "#ffffff", .72))
        assertEquals("#646467", mixColor("#222226", "#ffffff", .3))
        // Python round() rounds half to even.
        assertEquals("#020202", mixColor("#000000", "#050505", .5))
        assertEquals("#020202", mixColor("#000000", "#030303", .5))
        assertEquals("#020202", mixColor("#010101", "#020202", .5))
        assertEquals("#2f3744", highlightColor("#222226", "#78aeed"))
        assertEquals("#322c22", highlightColor("#101418", "#f0b45a"))
    }

    @Test fun quietAndLimitedColorsMatchPython() {
        assertEquals("#b6b6b7" to .67, quietColor("#222226", "#ffffff", .67, "#2f3744"))
        assertEquals("#a0a0a2" to .57, quietColor("#222226", "#ffffff", .5, "#2f3744"))
        assertEquals("#99999b" to .54, quietColor("#222226", "#ffffff", .5, "#313135"))
        assertEquals("#99948d" to .9, quietColor("#101418", "#a8a29a", .85, "#322c22"))
        assertEquals("#918d86" to .85, quietColor("#101418", "#a8a29a", .85, "#1f2326"))
        assertEquals("#333333" to 1.0, quietColor("#000000", "#333333", .5, "#000000"))
        assertEquals("#8a8a8c" to .47, limitedColor("#222226", "#ffffff"))
        assertEquals("#7e7e7c" to .51, limitedColor("#101418", "#e8e4dc"))
    }

    @Test fun sourceDotColorsMatchPython() {
        val fallback = listOf("#222226", "#2f3744")
        assertEquals("#8296b4", displaySourceColor("#8296b4", fallback))
        assertEquals("#b28f80", displaySourceColor("#b28f80", fallback))
        assertEquals("#77818a", displaySourceColor("#203040", fallback))
        assertEquals("#808080", displaySourceColor("#000000", fallback))
        assertEquals("#6e7883", displaySourceColor("#203040", listOf("#101418", "#322c22")))
        assertEquals("#757575", displaySourceColor("#000000", listOf("#101418", "#322c22")))
        assertEquals("#777777", displaySourceColor("#777777", listOf("#ffffff")))
        assertEquals("", displaySourceColor("#eeeeee", listOf("#ffffff")))
    }

    @Test fun derivedPaletteRolesFollowSetPalette() {
        val gnome = Palette()
        assertEquals(listOf("#c1c1c2", "#646467", "#313135", "#b6b6b7", "#99999b", "#8a8a8c", "#99999b"),
            listOf(gnome.muted, gnome.divider, gnome.highlight, gnome.quietTitle, gnome.quietCaption, gnome.limited,
                gnome.limitedPressed))
        assertEquals(listOf("#322c22", "#a19f9b", "#99948d", "#7e7e7c", "#969592"),
            listOf(custom.highlight, custom.quietTitle, custom.quietCaption, custom.limited, custom.limitedPressed))
    }

    @Test fun parseReadsTheDashboardFieldAndFallsBackPerKey() {
        val board = AsbJson.decodeFromString<Dashboard>("""{"palette":{"mode":"custom","colors":{
            "background":"#101418","text":"#E8E4DC","accent":"#f0b45a","muted":"#a8a29a","divider":"#3a3f46",
            "success":"#f0b45a","warning":"#f0b45a","extra":"#000000"},"future":1}}""")
        assertEquals(custom, Palette.parse(board.palette))
        assertNull(Palette.parse(AsbJson.decodeFromString<Dashboard>("{}").palette))
        assertNull(Palette.parse(AsbJson.decodeFromString<Dashboard>("""{"palette":null}""").palette))
        assertNull(Palette.parse(JsonNull))
        for (value in listOf("\"x\"", "7", "[]")) {
            assertNull(Palette.parse(AsbJson.decodeFromString<Dashboard>("""{"palette":$value}""").palette))
        }
        // Bad or missing values take the fallback; muted and divider mix the resolved text into the background.
        val partial = Palette.parse(Json.parseToJsonElement("""{"mode":"other","colors":{
            "background":"#000000","text":"white","accent":"#12345","muted":7,"success":"#00FF00"}}"""))
        assertEquals(Palette("gnome", "#000000", "#ffffff", "#78aeed", mixColor("#000000", "#ffffff", .72),
            mixColor("#000000", "#ffffff", .3), "#00ff00", "#f8e45c"), partial)
        assertEquals(Palette(), Palette.parse(Json.parseToJsonElement("{}")))
        assertEquals("#b8b8b8", partial!!.muted)
    }

    @Test fun savedJsonRoundTripsInTheDashboardShape() {
        assertEquals(custom, Palette.parse(Json.parseToJsonElement(custom.toJson())))
        assertEquals(Palette(), Palette.parse(Json.parseToJsonElement(Palette().toJson())))
        assertEquals("""{"mode":"gnome","colors":{"background":"#222226","text":"#ffffff","accent":"#78aeed",""" +
            """"muted":"#c1c1c2","divider":"#646467","success":"#8ff0a4","warning":"#f8e45c"}}""", Palette().toJson())
    }

    @Test fun controlOutlinesUseMutedWhenTheDividerIsTooClose() {
        // Contrast values from the desktop contrast(): 1.018 and 3.239.
        val black = Palette("custom", "#000000", "#ffffff", "#ffb900", "#bcbcbc", "#030303", "#ffb900", "#ffb900")
        assertEquals("#bcbcbc", local.asb.companion.ui.controlOutline(black))
        assertEquals("#5e5e5e", local.asb.companion.ui.controlOutline(black.copy(divider = "#5e5e5e")))
    }

    @Test fun inspectorEdgeMatchesPython() {
        // The black Custom palette: surface #0f0f0f, accent #ffb900.
        assertEquals("#0f0f0f", mixColor("#000000", "#ffffff", .06))
        assertEquals("#b78605", edgeColor("#0f0f0f", "#ffb900", .7, listOf("#000000", "#0f0f0f")))
        assertEquals("#65696e", edgeColor("#171c22", "#f0f2f5", .36, listOf("#171c22")))
        assertEquals("#101010", edgeColor("#000000", "#101010", .5, listOf("#000000")))
        // The GNOME fallback palette: surface #2f2f33.
        assertEquals("#2f2f33", mixColor("#222226", "#ffffff", .06))
        assertEquals("#6288b5", edgeColor("#2f2f33", "#78aeed", .7, listOf("#222226", "#2f2f33")))
    }

    @Test fun inspectorTextKeepsFourAndAHalfToOne() {
        assertEquals("#a8a29a", readableColor("#a8a29a", "#e8e4dc", listOf("#101418")))
        val raised = readableColor("#555555", "#ffffff", listOf("#0f0f0f", "#1d1d1d"))
        assertTrue(contrast(raised, "#0f0f0f") >= 4.5 && contrast(raised, "#1d1d1d") >= 4.5)
        assertTrue(contrast("#555555", "#0f0f0f") < 4.5)
        assertEquals(raised, readableColor(raised, "#ffffff", listOf("#0f0f0f", "#1d1d1d")))
    }
}
