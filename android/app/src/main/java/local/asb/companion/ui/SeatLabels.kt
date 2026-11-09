package local.asb.companion.ui

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import local.asb.companion.data.Chord
import local.asb.companion.data.SeatCount

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
 * How far (in dp) the largest ring that a pin can get on the phone reaches past its 16 dp, in every state: the 1 dp background
 * casing outside the 2 dp accent ring of a lit pin (to 18 dp). Every label place counts from there (the PC pin_ring), so a label
 * does not move when its seat is chosen.
 */
internal const val PIN_RING = 2f

/**
 * Port of pin_info texts: the whole title on one line (at most 24 characters, then …); the whole title on two lines split after
 * its last `-`, `_`, `.`, or space, when each line has 4 to 24 characters; then the title cut to 10 and to 7
 * characters, without trailing separators before the ….
 */
internal fun seatLabelTexts(title: String): List<String> {
    val names = mutableListOf(if (title.length <= 24) title else title.take(24) + "…")
    val split = LABEL_BREAK.findAll(title).map { it.range.last + 1 }.filter { it < title.length }.maxOrNull() ?: 0
    if (split > 0 && title.take(split).trim('-', '_', '.', ' ').isNotEmpty() && split in 4..24 && title.length - split in 4..24) {
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
 * inward (place 0), or 3 dp under (1), over (2), left of (3), or right of (4) the 32 dp pin and its rings ([ring] dp past the pin),
 * or at a diagonal: under-right (5), under-left (6), over-right (7), over-left (8), with the label corner nearest the pin at 45°
 * and the same gap.
 */
internal fun seatLabelPlace(center: Offset, rp: Float, degrees: Float, size: Size, place: Int, dp: Float, ring: Float = PIN_RING): Offset {
    val radians = Math.toRadians(degrees.toDouble())
    val along = { r: Float -> Offset(center.x + r * cos(radians).toFloat(), center.y + r * sin(radians).toFloat()) }
    if (place == 0) {
        val point = along(rp - seatLabelOffset(degrees, size.width / 2, dp) - ring * dp)
        return Offset(point.x - size.width / 2, point.y - size.height / 2)
    }
    val pin = along(rp)
    val gap = (16 + ring + 3) * dp
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
 * ([seatLabelWholeCount]), and its own [pin] circle; with a pin, a label stays nearer it than the pin of every other seat. [exits]
 * are the own exit circles of its chords ([exitCircles]), and [widest] those of its chord or chords with the largest rest width.
 */
internal class SeatLabelInput(val id: String, val degrees: Float, val sizes: List<Size>, val whole: Int = 1,
    val pin: Pair<Offset, Float>? = null, val exits: List<Pair<Offset, Float>> = emptyList(),
    val widest: List<Pair<Offset, Float>> = emptyList())

/** A placed label: the index of its text, its place, and its box (1 dp wider on each side than the text). */
internal data class SeatLabelSpot(val text: Int, val place: Int, val box: Rect)

/**
 * The table that the labels avoid: the center disc [rc] (when [disc]), the machine band from [ri] to [ro], [blocked] (the machine
 * labels and the shown key line), [circles] (center, radius: the not-sent end points), and [pins] (the [pinCircle] of each pin).
 * The [dashed] circles of the all-not-sent chords ([dashedCircles]) are kept-off shapes of every label.
 */
internal class LabelTable(val center: Offset, val rp: Float, val rc: Float, val disc: Boolean, val width: Float, val height: Float,
    val blocked: List<Rect>, val ri: Float = Float.MAX_VALUE, val ro: Float = Float.MAX_VALUE,
    val circles: List<Pair<Offset, Float>> = emptyList(), val pins: List<Pair<Offset, Float>> = emptyList(),
    val dashed: List<Pair<Offset, Float>> = emptyList())

/** A pin as a label obstacle: the outer edge of its largest ring (16 + [PIN_RING] dp), less the PC 0.5 tolerance. */
internal fun pinCircle(pin: Offset, dp: Float): Pair<Offset, Float> = pin to (16 + PIN_RING - .5f) * dp

/**
 * The own exits of a seat on one chord of [length] px: from the pin rim (16 dp from the pin center, along the chord) to 28 dp
 * farther, every 4 dp, as circles of half the [restWidth] plus 2 dp. [pointAt] gives the point at a fraction of the length;
 * [fromStart] is true for the seat at the start of the chord.
 */
internal fun exitCircles(length: Float, pointAt: (Float) -> Offset, fromStart: Boolean, restWidth: Float, dp: Float): List<Pair<Offset, Float>> =
    if (length <= 0) emptyList() else (0..7).map { i ->
        val fraction = min(1f, (16 + 4 * i) * dp / length)
        pointAt(if (fromStart) fraction else 1 - fraction) to restWidth / 2 + 2 * dp
    }

/** An all-not-sent chord of [length] px along its whole drawn length, every 4 dp, as circles of half its [width] plus 3 dp. */
internal fun dashedCircles(length: Float, pointAt: (Float) -> Offset, width: Float, dp: Float): List<Pair<Offset, Float>> {
    if (length <= 0) return emptyList()
    val steps = max(1, ceil(length / (4 * dp)).toInt())
    return (0..steps).map { pointAt(it.toFloat() / steps) to width / 2 + 3 * dp }
}

/** A not-sent end point as a label obstacle: half the end width and 1 dp. */
internal fun endCircle(point: Offset, endWidth: Float, dp: Float): Pair<Offset, Float> = point to endWidth / 2 + 1 * dp

/**
 * Port of place_labels. The [chosen] seats place first (in that order) and show only their whole texts; then the [partners] (the
 * seats lit by the selection), then the other seats; each group by message count, then the newest activity, then circle order
 * ([seats] order). Each label takes the first free place in [labelOptions] order. A free place stays 2 dp inside the table, off
 * the center disc (when [LabelTable.disc]), off the machine band, off each blocked box and circle, 6 dp from each placed label on
 * its left and right, and at least 4 dp nearer its own pin circle than every other pin circle.
 *
 * A seat in [previous] (the last placement, kept over a selection change) first tries its text and place there. With no free
 * place, one placed label that is not chosen and blocks a place can move to another free place with its text; the move stays only
 * when both labels are then free. Then the seat tries all its texts and places with 2 dp for the own-pin rule, then once more placed
 * from the 16 dp pin itself (no rings, the pin circles at 16 dp). Then a chosen seat shows its one-line text inward, and another
 * seat hides (null).
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
    // A box touches a kept-off circle when its nearest point is nearer than the radius.
    fun touches(box: Rect, circles: List<Pair<Offset, Float>>) = circles.any { near(box, it.first) < it.second }
    val room = 6 * dp
    val byId = seats.associateBy { it.id }
    fun box(seat: SeatLabelInput, text: Int, place: Int, ring: Float = PIN_RING): Rect {
        val size = seat.sizes[text]
        val at = seatLabelPlace(c, table.rp, seat.degrees, size, place, dp, ring)
        return Rect(at.x - 1 * dp, at.y, at.x + size.width + 1 * dp, at.y + size.height)
    }
    val spots = LinkedHashMap<String, SeatLabelSpot?>()
    fun blockers(id: String, b: Rect): List<String> = spots.filter { (other, spot) ->
        other != id && spot != null && hit(Rect(spot.box.left - room, spot.box.top, spot.box.right + room, spot.box.bottom), b)
    }.keys.toList()
    // The distance to a pin circle: from its center to the nearest point of the box, less its radius ([shrink] less with no rings).
    fun nearerOwnPin(seat: SeatLabelInput, b: Rect, margin: Float, shrink: Float): Boolean {
        val own = seat.pin ?: return true
        val mine = near(b, own.first) - own.second + shrink
        return seats.all { other -> other.id == seat.id || other.pin == null || near(b, other.pin.first) - other.pin.second + shrink >= mine + margin * dp }
    }
    fun free(seat: SeatLabelInput, b: Rect, labels: Boolean = true, margin: Float = 4f, shrink: Float = 0f): Boolean {
        val inside = b.left >= 2 * dp && b.top >= 2 * dp && b.right <= table.width - 2 * dp && b.bottom <= table.height - 2 * dp
        // A box is free of a circle when the nearest point of the box is farther than the radius from the circle center.
        return inside && !(table.disc && onDisc(b)) && !onBand(b) && table.blocked.none { hit(it, b) } &&
            table.circles.none { near(b, it.first) <= it.second } && table.pins.none { near(b, it.first) <= it.second - shrink } &&
            nearerOwnPin(seat, b, margin, shrink) && (!labels || blockers(seat.id, b).isEmpty())
    }
    fun fits(seat: SeatLabelInput, b: Rect, tier: Int) = when (tier) {
        0 -> !touches(b, seat.exits) && !touches(b, table.dashed)
        1 -> !touches(b, seat.widest)
        else -> true
    }
    val order = seats.withIndex().sortedWith(compareBy<IndexedValue<SeatLabelInput>>(
        { chosen.indexOf(it.value.id).let { i -> if (i < 0) chosen.size else i } }, { if (it.value.id in partners) 0 else 1 },
        { -(messages[it.value.id] ?: 0) }, { -(activity[it.value.id] ?: 0L) }, { it.index })).map { it.value }
    for (seat in order) {
        val isChosen = seat.id in chosen
        val texts = if (isChosen) min(seat.whole, seat.sizes.size) else seat.sizes.size
        val options = labelOptions(texts, seat.whole).toMutableList()
        previous[seat.id]?.takeIf { it.text < texts }?.let { options.add(0, LabelOption(it.text, it.place, 2)) }
        fun firstFree(margin: Float, ring: Float = PIN_RING) = options.firstNotNullOfOrNull { (text, place, tier) ->
            box(seat, text, place, ring).takeIf { free(seat, it, margin = margin, shrink = (PIN_RING - ring) * dp) && fits(seat, it, tier) }
                ?.let { SeatLabelSpot(text, place, it) }
        }
        var found = firstFree(4f)
        // Repair: move the one label that blocks a place to a free place with its text, when both labels are then free.
        if (found == null) repair@ for ((text, place, tier) in options) {
            val b = box(seat, text, place)
            val blocked = blockers(seat.id, b)
            if (!free(seat, b, labels = false) || !fits(seat, b, tier) || blocked.size != 1 || blocked[0] in chosen) continue
            val other = blocked[0]
            val old = spots.getValue(other)!!
            val otherSeat = byId.getValue(other)
            val item = SeatLabelSpot(text, place, b)
            spots[seat.id] = item
            for (keep in 0..2) for (move in 0..8) {
                val moved = box(otherSeat, old.text, move)
                if (!free(otherSeat, moved) || !fits(otherSeat, moved, keep)) continue
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
        // The last try before a hidden label: places from the 16 dp pin itself, as if no pin had rings; a ring can then draw under it.
        if (found == null) found = firstFree(2f, ring = 0f)
        // No free place: a chosen seat shows its one-line text inward, and the other labels avoid it.
        if (found == null && isChosen) found = SeatLabelSpot(0, 0, box(seat, 0, 0))
        spots[seat.id] = found
    }
    return spots
}

/** A label option of [labelOptions]: a text, a place, and a tier (0: touches no kept-off circle, 1: no circle of widest, 2: any). */
internal data class LabelOption(val text: Int, val place: Int, val tier: Int)

/**
 * The order in which a label tries its [texts] (the first [whole] are the whole-name texts, the others the cut texts): for each
 * group in order, for each text its nine places that touch no kept-off circle, then its nine places that touch no circle of
 * widest; then for each text of the group its nine places that touch a circle of widest.
 */
internal fun labelOptions(texts: Int, whole: Int): List<LabelOption> = listOf(0 until min(whole, texts), min(whole, texts) until texts).flatMap { group ->
    group.flatMap { text -> (0..1).flatMap { tier -> (0..8).map { LabelOption(text, it, tier) } } } +
        group.flatMap { text -> (0..8).map { LabelOption(text, it, 2) } }
}

/**
 * Port of region_fill: the machine whose sector holds [point] (between the drawn center disc, radius [inner], and [ri]), whose
 * sector tint is the fill there; null for the center disc and the background.
 */
internal fun regionMachine(point: Offset, center: Offset, inner: Float, ri: Float, ranges: Map<String, Pair<Float, Float>>): String? {
    val radius = hypot(point.x - center.x, point.y - center.y)
    if (radius <= inner || radius >= ri) return null
    val angle = Math.toDegrees(atan2((point.y - center.y).toDouble(), (point.x - center.x).toDouble())).toFloat()
    return ranges.entries.firstOrNull { (_, arc) -> ((angle - arc.first) % 360 + 360) % 360 < arc.second - arc.first }?.key
}

/** The fill of a Busiest pairs or Between machines share bar: its count over the period [total] (D14 A). */
internal fun shareFill(count: Int, total: Int): Float = if (total > 0) count.toFloat() / total else 0f

/**
 * Port of CountStrip.names: which parts of the strip caption fit between the end names, whose inner edges are [left] and [right]:
 * 2 for `per hour · ● not sent` (only when [bad]), 1 for `per hour`, 0 for none. The caption keeps 12 dp from each name; [unit]
 * is the width of `per hour`, [rest] the width of ` · `, the dot, and ` not sent`.
 */
internal fun stripCaptionParts(left: Float, right: Float, unit: Float, rest: Float, bad: Boolean, dp: Float): Int {
    val room = right - left - 24 * dp
    return when {
        bad && unit + rest <= room -> 2
        unit <= room -> 1
        else -> 0
    }
}

/** The share words of a Busiest pairs or Between machines row, in the Usage percent format: `29.2% of all messages`. */
internal fun shareWords(share: Float): String = "${formatShare(share.toDouble())} of all messages"

/** The direction counts of a seat for TalkBack: `10 outgoing, 8 incoming`. */
internal fun seatDirections(count: SeatCount?): String = "${count?.sent ?: 0} outgoing, ${count?.received ?: 0} incoming"

/** The hint of the empty Messages block. */
internal const val MESSAGES_EMPTY_HINT = "When an agent sends a message to another session with ASB Bridge, it shows here."

/** The icon (dp) and the bold title (sp) sizes of the empty block in a center disc [disc] dp across: 96 and 20, from 520 dp 128 and 26. */
internal fun emptyBlockSizes(disc: Float): Pair<Int, Int> = if (disc < 520) 96 to 20 else 128 to 26

/** The center of the device pixel at [value] px (pixels are whole in a Canvas draw scope). */
internal fun pixelCenter(value: Float): Float = kotlin.math.floor(value) + .5f

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
