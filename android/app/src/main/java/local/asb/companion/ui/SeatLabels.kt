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
import local.asb.companion.data.Chord

// Pure parts of the Messages screen (scripts/asb-native.py RoundTable and CountStrip), free of Android classes so unit tests can call them.

/**
 * Port of the layout_table fails: the near and the far arc length of the not-sent receiver end of a chord of [length] px. The end
 * starts at the receiver pin rim (16 dp from its center) and runs 24 dp, at most half of the chord, away from the pin; [forward]
 * ends at the second pin (length), else at the first (0).
 */
internal fun notSentEndSpan(length: Float, dp: Float, forward: Boolean): Pair<Float, Float> {
    val part = min(24 * dp, length / 2)
    val rim = 16 * dp
    val near = if (forward) max(0f, length - rim) else min(length, rim)
    return near to if (forward) max(0f, near - part) else min(length, near + part)
}

/**
 * The part (fractions of a chord of [length] px) that the chord stroke draws, from the [trim] at its not-sent ends: each trimmed
 * side stops 2 dp plus half the stroke [width] (its round cap) before the end, so the background shows between them.
 */
internal fun strokeTrim(trim: Pair<Float, Float>, length: Float, width: Float, dp: Float): Pair<Float, Float> {
    if (length <= 0) return trim
    val gap = (2 * dp + width / 2) / length
    return (trim.first + if (trim.first > 0) gap else 0f) to (trim.second - if (trim.second < 1) gap else 0f)
}

// Port of the PC seat label placement (RoundTable.place_labels and label_place_with).

private val LABEL_BREAK = Regex("[-_. ]")

/**
 * Port of pin_info texts: the whole title on one line (at most 24 characters, then …); the whole title on two lines split after
 * its last `-`, `_`, `.`, or space, when both lines have text and at most 24 characters; then the title cut to 10 and to 7
 * characters, without trailing separators before the ….
 */
internal fun seatLabelTexts(title: String): List<String> {
    val names = mutableListOf(if (title.length <= 24) title else title.take(24) + "…")
    val split = LABEL_BREAK.findAll(title).map { it.range.last + 1 }.filter { it < title.length }.maxOrNull() ?: 0
    if (split > 0 && title.take(split).trim('-', '_', '.', ' ').isNotEmpty() && split <= 24 && title.length - split <= 24) {
        names += title.take(split) + "\n" + title.drop(split)
    }
    names += listOf(10, 7).filter { title.length > it }.map { title.take(it).trimEnd('-', '_', '.', ' ') + "…" }
    return names.distinct()
}

/** How many of [texts] (from [seatLabelTexts]) are the whole title: the one-line text, and the two-line text when there is one. */
internal fun seatLabelWholeCount(texts: List<String>): Int = if (texts.getOrNull(1)?.contains('\n') == true) 2 else 1

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

/**
 * A seat to label: its angle on the pin circle, the size of each of its [seatLabelTexts], how many of them are [whole]
 * ([seatLabelWholeCount]), and its own [pin] circle; with a pin, a label stays nearer it than the pin of every other seat.
 */
internal class SeatLabelInput(val id: String, val degrees: Float, val sizes: List<Size>, val whole: Int = 1,
    val pin: Pair<Offset, Float>? = null)

/** A placed label: the index of its text, its place, and its box (1 dp wider on each side than the text). */
internal data class SeatLabelSpot(val text: Int, val place: Int, val box: Rect)

/**
 * The table that the labels avoid: the center disc [rc] (when [disc]), the machine band from [ri] to [ro], [blocked] (the machine
 * labels and the shown key line), and [circles] (center, radius): the pins and the not-sent end points.
 */
internal class LabelTable(val center: Offset, val rp: Float, val rc: Float, val disc: Boolean, val width: Float, val height: Float,
    val blocked: List<Rect>, val ri: Float = Float.MAX_VALUE, val ro: Float = Float.MAX_VALUE,
    val circles: List<Pair<Offset, Float>> = emptyList())

/** A pin as a label obstacle: the 17 dp outer edge of the 2 dp accent ring, less the PC 0.5 tolerance. */
internal fun pinCircle(pin: Offset, dp: Float): Pair<Offset, Float> = pin to 16.5f * dp

/** A not-sent end point as a label obstacle: half the end width and 1 dp. */
internal fun endCircle(point: Offset, endWidth: Float, dp: Float): Pair<Offset, Float> = point to endWidth / 2 + 1 * dp

/**
 * Port of place_labels. The [chosen] seats place first (in that order) and show only their whole texts; then the [partners] (the
 * seats lit by the selection), then the other seats; each group by message count, then the newest activity, then circle order
 * ([seats] order). Each label takes the first free place of the nine with each of its texts in order. A free place stays 2 dp
 * inside the table, off the center disc (when [LabelTable.disc]), off the machine band, off each blocked box and circle, 6 dp from
 * each placed label on its left and right, and at least 4 dp nearer its own pin circle than every other pin circle.
 *
 * A seat in [previous] (the last placement, kept over a selection change) first tries its text and place there. With no free
 * place, one placed label that is not chosen and blocks a place can move to another free place with its text; the move stays only
 * when both labels are then free. Then the seat tries all its texts and places with 2 dp for the own-pin rule. Then a chosen seat
 * shows its one-line text inward, and another seat hides (null).
 */
internal fun placeSeatLabels(seats: List<SeatLabelInput>, chosen: List<String>, messages: Map<String, Int>, activity: Map<String, Long>,
    table: LabelTable, dp: Float, partners: Set<String> = emptySet(), previous: Map<String, SeatLabelSpot?> = emptyMap()): Map<String, SeatLabelSpot?> {
    val c = table.center
    fun hit(a: Rect, b: Rect) = a.left < b.right - .5f && b.left < a.right - .5f && a.top < b.bottom - .5f && b.top < a.bottom - .5f
    fun near(box: Rect, p: Offset = c): Float = hypot(p.x.coerceIn(box.left, box.right) - p.x, p.y.coerceIn(box.top, box.bottom) - p.y)
    fun onDisc(box: Rect): Boolean = near(box) < table.rc + 2 * dp
    fun onBand(box: Rect): Boolean {
        val far = listOf(box.left, box.right).maxOf { x -> listOf(box.top, box.bottom).maxOf { y -> hypot(x - c.x, y - c.y) } }
        return near(box) < table.ro + 2 * dp && far > table.ri - 2 * dp
    }
    val room = 6 * dp
    val byId = seats.associateBy { it.id }
    fun box(seat: SeatLabelInput, text: Int, place: Int): Rect {
        val size = seat.sizes[text]
        val at = seatLabelPlace(c, table.rp, seat.degrees, size, place, dp)
        return Rect(at.x - 1 * dp, at.y, at.x + size.width + 1 * dp, at.y + size.height)
    }
    val spots = LinkedHashMap<String, SeatLabelSpot?>()
    fun blockers(id: String, b: Rect): List<String> = spots.filter { (other, spot) ->
        other != id && spot != null && hit(Rect(spot.box.left - room, spot.box.top, spot.box.right + room, spot.box.bottom), b)
    }.keys.toList()
    // The distance to a pin circle: from its center to the nearest point of the box, less its radius.
    fun nearerOwnPin(seat: SeatLabelInput, b: Rect, margin: Float): Boolean {
        val own = seat.pin ?: return true
        val mine = near(b, own.first) - own.second
        return seats.all { other -> other.id == seat.id || other.pin == null || near(b, other.pin.first) - other.pin.second >= mine + margin * dp }
    }
    fun free(seat: SeatLabelInput, b: Rect, labels: Boolean = true, margin: Float = 4f): Boolean {
        val inside = b.left >= 2 * dp && b.top >= 2 * dp && b.right <= table.width - 2 * dp && b.bottom <= table.height - 2 * dp
        // A box is free of a circle when the nearest point of the box is farther than the radius from the circle center.
        return inside && !(table.disc && onDisc(b)) && !onBand(b) && table.blocked.none { hit(it, b) } &&
            table.circles.none { near(b, it.first) <= it.second } && nearerOwnPin(seat, b, margin) && (!labels || blockers(seat.id, b).isEmpty())
    }
    val order = seats.withIndex().sortedWith(compareBy<IndexedValue<SeatLabelInput>>(
        { chosen.indexOf(it.value.id).let { i -> if (i < 0) chosen.size else i } }, { if (it.value.id in partners) 0 else 1 },
        { -(messages[it.value.id] ?: 0) }, { -(activity[it.value.id] ?: 0L) }, { it.index })).map { it.value }
    for (seat in order) {
        val isChosen = seat.id in chosen
        val texts = if (isChosen) min(seat.whole, seat.sizes.size) else seat.sizes.size
        val options = (0 until texts).flatMap { text -> (0..8).map { text to it } }.toMutableList()
        previous[seat.id]?.takeIf { it.text < texts }?.let { options.add(0, it.text to it.place) }
        fun firstFree(margin: Float) = options.firstNotNullOfOrNull { (text, place) ->
            box(seat, text, place).takeIf { free(seat, it, margin = margin) }?.let { SeatLabelSpot(text, place, it) }
        }
        var found = firstFree(4f)
        // Repair: move the one label that blocks a place to a free place with its text, when both labels are then free.
        if (found == null) repair@ for ((text, place) in options) {
            val b = box(seat, text, place)
            val blocked = blockers(seat.id, b)
            if (!free(seat, b, labels = false) || blocked.size != 1 || blocked[0] in chosen) continue
            val other = blocked[0]
            val old = spots.getValue(other)!!
            val otherSeat = byId.getValue(other)
            val item = SeatLabelSpot(text, place, b)
            spots[seat.id] = item
            for (move in 0..8) {
                val moved = box(otherSeat, old.text, move)
                if (!free(otherSeat, moved)) continue
                spots[other] = SeatLabelSpot(old.text, move, moved)
                if (free(seat, b)) {
                    found = item
                    break@repair
                }
                spots[other] = old
            }
            spots[other] = old
            spots.remove(seat.id)
        }
        // A crowded seat: its own pin may be nearer by 2 dp only.
        if (found == null) found = firstFree(2f)
        // No free place: a chosen seat shows its one-line text inward, and the other labels avoid it.
        if (found == null && isChosen) found = SeatLabelSpot(0, 0, box(seat, 0, 0))
        spots[seat.id] = found
    }
    return spots
}

// Port of the CountStrip geometry, in px: a [plot] high plot with an [inset] at the top, the bottom, and both ends.

/** The x of bucket [index] of [count] buckets on a strip [width] wide; one bucket stands in the middle. */
internal fun stripX(index: Int, count: Int, width: Float, inset: Float): Float {
    val span = width - 2 * inset
    return inset + if (count > 1) index * span / (count - 1) else span / 2
}

/** The y of a bucket with [value] messages: [value] over [largest] of the plot between the insets, from the bottom inset. */
internal fun stripY(value: Int, largest: Int, plot: Float, inset: Float): Float =
    plot - inset - (plot - 2 * inset) * value / max(1, largest)

/** The bucket nearest [x], so the hit areas split at the midpoints between the points; null with no buckets. */
internal fun stripBucketAt(x: Float, count: Int, width: Float, inset: Float): Int? =
    (0 until count).minByOrNull { abs(stripX(it, count, width, inset) - x) }

/** The left x of a tip [textWidth] wide, centered on [x] and kept inside the strip. */
internal fun stripTipLeft(x: Float, textWidth: Float, width: Float): Float = (x - textWidth / 2).coerceIn(0f, max(0f, width - textWidth))

/** Port of the chord tooltip: one part per direction (`release-plan → parser-review: 75`), then `Not sent: 3` when the pair has some. */
internal fun chordText(chord: Chord, title: (String) -> String): String =
    listOfNotNull("${title(chord.a)} → ${title(chord.b)}: ${formatCount(chord.ab.toLong())}",
        "${title(chord.b)} → ${title(chord.a)}: ${formatCount(chord.ba.toLong())}",
        (chord.badAb + chord.badBa).takeIf { it > 0 }?.let { "Not sent: ${formatCount(it.toLong())}" }).joinToString(", ")
