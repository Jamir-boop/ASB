package local.asb.companion.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** One row of the card marks legend: the corner control it draws (null for the bell), the usage limit clock, and its words. */
internal data class CardMark(val control: CornerControl?, val limit: Boolean, val words: String)

/** The card marks in legend order, with the PC legend words (DESIGN.md); the card TalkBack words are [cornerMeaning]. */
internal val CARD_MARKS = listOf(
    CardMark(CornerControl("question", "mark-read", ""), false, "Needs your answer or approval"),
    CardMark(CornerControl("question", null, ""), false, "Waiting for approval, read"),
    CardMark(CornerControl("alert", "mark-read", ""), false, "Failed"),
    CardMark(CornerControl("alert", "mark-read", ""), true, "Usage limit"),
    CardMark(CornerControl("dot", "mark-read", ""), false, "Unread"),
    CardMark(CornerControl("discard", "keep-result", ""), false, "Mark read when done"),
    CardMark(CornerControl("pin", "unpin", ""), false, "Pinned"),
    CardMark(CornerControl("drawer", "drawer-out", ""), false, "In the drawer"),
    CardMark(null, false, "Muted"),
)

/** The Settings legend of the card marks (the PC explains them in hover tooltips); each row is one TalkBack node. */
@Composable
internal fun CardMarksLegend() {
    val palette = LocalPalette.current
    HorizontalDivider()
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("Card marks", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
        for (mark in CARD_MARKS) Row(
            Modifier.fillMaxWidth().heightIn(min = 40.dp).clearAndSetSemantics { contentDescription = mark.words },
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
                if (mark.control != null) CornerGlyph(mark.control, mark.limit, palette) else MutedGlyph(palette.muted)
            }
            Text(mark.words, style = MaterialTheme.typography.bodyLarge)
        }
    }
}
