package local.asb.companion.ui

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

// Pure parts of the Messages round table (scripts/asb-native.py RoundTable), free of Android classes so unit tests can call them.

/**
 * Port of the layout_table fails: the near and the far arc length of the not-sent receiver end of a chord of [length] px. The end
 * starts at the receiver pin rim (16 dp from its center) and runs 15% of the chord, at least 24 dp and at most half of the chord,
 * away from the pin; [forward] ends at the second pin (length), else at the first (0).
 */
internal fun notSentEndSpan(length: Float, dp: Float, forward: Boolean): Pair<Float, Float> {
    val part = min(max(24 * dp, .15f * length), length / 2)
    val rim = 16 * dp
    val near = if (forward) max(0f, length - rim) else min(length, rim)
    return near to if (forward) max(0f, near - part) else min(length, near + part)
}

// Port of the PC seat label placement (RoundTable.place_labels and label_place_with).

/** Port of pin_info texts: the whole title (at most 24 characters, then …), then the title cut to 10 and to 7 characters. */
internal fun seatLabelTexts(title: String): List<String> =
    (listOf(if (title.length <= 24) title else title.take(24) + "…") +
        listOf(10, 7).filter { title.length > it }.map { title.take(it) + "…" }).distinct()

/** Port of seat_label_offset: how far a label sits inward from its pin, 30 dp or more where a wide label would touch its pin. */
internal fun seatLabelOffset(degrees: Float, halfWidth: Float, dp: Float): Float {
    val radians = Math.toRadians(degrees.toDouble())
    val ux = abs(cos(radians)).toFloat()
    val uy = abs(sin(radians)).toFloat()
    return max(30 * dp, min(if (ux > .01f) (20 * dp + halfWidth) / ux else Float.MAX_VALUE, if (uy > .01f) 27 * dp / uy else Float.MAX_VALUE))
}

/**
 * Port of label_place_with: the top left of a [size] label of the pin at [degrees] on the pin circle [rp] around [center]:
 * inward (place 0), or 3 dp under (1), over (2), left of (3), or right of (4) the 32 dp pin, or at a diagonal: under-right (5),
 * under-left (6), over-right (7), over-left (8), with the label corner nearest the pin at 45° and the same gap.
 */
internal fun seatLabelPlace(center: Offset, rp: Float, degrees: Float, size: Size, place: Int, dp: Float): Offset {
    val radians = Math.toRadians(degrees.toDouble())
    val along = { r: Float -> Offset(center.x + r * cos(radians).toFloat(), center.y + r * sin(radians).toFloat()) }
    if (place == 0) {
        val point = along(rp - seatLabelOffset(degrees, size.width / 2, dp))
        return Offset(point.x - size.width / 2, point.y - size.height / 2)
    }
    val pin = along(rp)
    val gap = 16 * dp + 3 * dp
    val d = .707f * gap
    return when (place) {
        1 -> Offset(pin.x - size.width / 2, pin.y + gap)
        2 -> Offset(pin.x - size.width / 2, pin.y - gap - size.height)
        3 -> Offset(pin.x - gap - size.width, pin.y - size.height / 2)
        4 -> Offset(pin.x + gap, pin.y - size.height / 2)
        5 -> Offset(pin.x + d, pin.y + d)
        6 -> Offset(pin.x - d - size.width, pin.y + d)
        7 -> Offset(pin.x + d, pin.y - d - size.height)
        else -> Offset(pin.x - d - size.width, pin.y - d - size.height)
    }
}

/** A seat to label: its angle on the pin circle and the size of each of its [seatLabelTexts]. */
internal class SeatLabelInput(val id: String, val degrees: Float, val sizes: List<Size>)

/** A placed label: the index of its text, its place, and its box (1 dp wider on each side than the text). */
internal data class SeatLabelSpot(val text: Int, val place: Int, val box: Rect)

/**
 * The table that the labels avoid: the center disc [rc] (when [disc]), the machine band from [ri] to [ro], and [blocked]: the pins,
 * the machine labels, the not-sent ends, and the shown key line.
 */
internal class LabelTable(val center: Offset, val rp: Float, val rc: Float, val disc: Boolean, val width: Float, val height: Float,
    val blocked: List<Rect>, val ri: Float = Float.MAX_VALUE, val ro: Float = Float.MAX_VALUE)

/**
 * Port of place_labels. The [chosen] seats place first (in that order) and show only their whole text, inward when no place is
 * free; then the [partners] (the seats lit by the selection), then the other seats; each group by message count, then the newest
 * activity, then circle order ([seats] order). Each label takes the first free place of the nine with its whole text, then with
 * the cut texts; else it hides (null). A free place stays 2 dp inside the table, off the center disc (when [LabelTable.disc]),
 * off the machine band, off each blocked box, and 6 dp from each placed label on its left and right.
 */
internal fun placeSeatLabels(seats: List<SeatLabelInput>, chosen: List<String>, messages: Map<String, Int>, activity: Map<String, Long>,
    table: LabelTable, dp: Float, partners: Set<String> = emptySet()): Map<String, SeatLabelSpot?> {
    val c = table.center
    fun hit(a: Rect, b: Rect) = a.left < b.right - .5f && b.left < a.right - .5f && a.top < b.bottom - .5f && b.top < a.bottom - .5f
    fun near(box: Rect): Float = hypot(c.x.coerceIn(box.left, box.right) - c.x, c.y.coerceIn(box.top, box.bottom) - c.y)
    fun onDisc(box: Rect): Boolean = near(box) < table.rc + 2 * dp
    fun onBand(box: Rect): Boolean {
        val far = listOf(box.left, box.right).maxOf { x -> listOf(box.top, box.bottom).maxOf { y -> hypot(x - c.x, y - c.y) } }
        return near(box) < table.ro + 2 * dp && far > table.ri - 2 * dp
    }
    val room = 6 * dp
    fun box(seat: SeatLabelInput, text: Int, place: Int): Rect {
        val size = seat.sizes[text]
        val at = seatLabelPlace(c, table.rp, seat.degrees, size, place, dp)
        return Rect(at.x - 1 * dp, at.y, at.x + size.width + 1 * dp, at.y + size.height)
    }
    val order = seats.withIndex().sortedWith(compareBy<IndexedValue<SeatLabelInput>>(
        { chosen.indexOf(it.value.id).let { i -> if (i < 0) chosen.size else i } }, { if (it.value.id in partners) 0 else 1 },
        { -(messages[it.value.id] ?: 0) }, { -(activity[it.value.id] ?: 0L) }, { it.index })).map { it.value }
    val placed = mutableListOf<Rect>()
    val spots = LinkedHashMap<String, SeatLabelSpot?>()
    for (seat in order) {
        val isChosen = seat.id in chosen
        var found: SeatLabelSpot? = null
        search@ for (text in 0 until if (isChosen) 1 else seat.sizes.size) {
            for (place in 0..8) {
                val b = box(seat, text, place)
                val inside = b.left >= 2 * dp && b.top >= 2 * dp && b.right <= table.width - 2 * dp && b.bottom <= table.height - 2 * dp
                if (inside && !(table.disc && onDisc(b)) && !onBand(b) && table.blocked.none { hit(it, b) } &&
                    placed.none { hit(Rect(it.left - room, it.top, it.right + room, it.bottom), b) }) {
                    found = SeatLabelSpot(text, place, b)
                    break@search
                }
            }
        }
        // No free place: a chosen seat shows its whole label inward, and the other labels avoid it.
        if (found == null && isChosen) found = SeatLabelSpot(0, 0, box(seat, 0, 0))
        found?.let { placed += it.box }
        spots[seat.id] = found
    }
    return spots
}
