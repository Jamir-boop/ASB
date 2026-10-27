package local.asb.companion

import androidx.compose.ui.graphics.Color
import local.asb.companion.data.Palette
import local.asb.companion.ui.activityColorsOf
import org.junit.Assert.assertEquals
import org.junit.Test

class ActivityColorsTest {
    @Test fun blackBoardPaletteKeepsFlatSurfacesAndVisibleTracksAndEdges() {
        val colors = activityColorsOf(Palette(
            background = "#000000", text = "#ffffff", accent = "#ffb900", muted = "#bcbcbc", divider = "#030303",
        ))
        assertEquals(Color(0xFF000000), colors.background)
        assertEquals(Color(0xFF2B2B2B), colors.track)
        assertEquals(Color(0xFF5C5C5C), colors.edge)
        assertEquals(Color(0xFF212121), colors.rule)
        assertEquals(Color(0xFF030303), colors.divider)
        assertEquals(Color(0xFFFFFFFF), colors.text)
        assertEquals(Color(0xFFBCBCBC), colors.muted)
        assertEquals(Color(0xFFFFB900), colors.accent)
    }

    @Test fun coloredBoardPaletteKeepsFlatSurfacesAndDerivedColors() {
        val colors = activityColorsOf(Palette(
            background = "#101820", text = "#f0f0f0", accent = "#3080c0", muted = "#a0a0a0", divider = "#405060",
        ))
        assertEquals(Color(0xFF101820), colors.background)
        assertEquals(Color(0xFF363D43), colors.track)
        assertEquals(Color(0xFF61666B), colors.edge)
        assertEquals(Color(0xFF2D343B), colors.rule)
        assertEquals(Color(0xFF405060), colors.divider)
        assertEquals(Color(0xFFF0F0F0), colors.text)
        assertEquals(Color(0xFFA0A0A0), colors.muted)
        assertEquals(Color(0xFF3080C0), colors.accent)
    }
}
