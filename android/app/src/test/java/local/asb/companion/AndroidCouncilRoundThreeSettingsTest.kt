package local.asb.companion

import androidx.compose.ui.text.font.FontWeight
import local.asb.companion.data.Palette
import local.asb.companion.ui.TEXT_SCALE_CHOICES
import local.asb.companion.ui.VIEW_CHOICES
import local.asb.companion.ui.activityColorsOf
import local.asb.companion.ui.selectedChoiceStyle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class AndroidCouncilRoundThreeSettingsTest {
    @Test fun theSettingsChoiceRowsHaveTheD17AStyle() {
        // View and Card text size use ChoiceRow, which draws the selected segment with selectedChoiceStyle.
        val colors = activityColorsOf(Palette(background = "#222226", text = "#ffffff", accent = "#78aeed"))
        val style = selectedChoiceStyle(colors)
        assertEquals(colors.track, style.container)
        assertEquals(colors.choice, style.content)
        assertEquals(FontWeight.Bold, style.weight)
        assertNotEquals(colors.accent, style.container)
    }

    @Test fun theSettingsChoicesKeepTheirLabelsOrderAndValues() {
        assertEquals(listOf("compact" to "Compact", "comfortable" to "Comfortable"), VIEW_CHOICES)
        assertEquals(listOf("Small", "Normal", "Large", "Larger"), TEXT_SCALE_CHOICES.map { it.second })
        // Each text size saves the same Float as before, and the saved Float selects its own segment.
        val scales = listOf(0.85f, 1f, 1.15f, 1.3f)
        assertEquals(scales, TEXT_SCALE_CHOICES.map { it.first.toFloat() })
        assertEquals(TEXT_SCALE_CHOICES.map { it.first }, scales.map { it.toString() })
    }
}
