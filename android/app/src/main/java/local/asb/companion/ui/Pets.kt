package local.asb.companion.ui

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.produceState
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/** The Pets choices in the Settings order; the board pets are the last three. */
val PET_NAMES = listOf("off", "crab", "pigeon", "cat")
val PET_FRAMES = listOf("stand", "walk1", "walk2", "walk3", "walk4", "crouch", "air", "air2", "toss", "release")

/** A paint run in sprite pixels; a null color is the message color. */
data class PetRun(val color: String?, val x: Int, val y: Int, val width: Int)
/** [runs] is (right, left); [envelope] is the held envelope top-left (right, left), or null. */
data class PetFrame(val runs: List<List<PetRun>>, val envelope: List<Pair<Int, Int>>?)
data class Pet(
    val width: Int, val height: Int, val anchor: Pair<Int, Int>, val mirror: Boolean, val walkFps: Int,
    val frames: Map<String, PetFrame>,
) {
    val reach get() = width - anchor.first
}
data class Pets(val envelope: List<PetRun>, val pets: Map<String, Pet>)
/** A card end in dp: the mark center and the card floor. */
data class PetPoint(val x: Double, val y: Double, val floor: Double)
data class PetPhase(val name: String, val start: Double, val end: Double)
data class PetPlan(val direction: Int, val sameRow: Boolean, val phases: List<PetPhase>, val ta: Double, val end: Double)
data class PetPose(val frame: String, val x: Double, val y: Double, val face: Int, val clip: Double?)
data class PetBox(val runs: List<PetRun>, val left: Int, val top: Int, val flip: Boolean)
data class PetParticle(val x: Int, val y: Int, val alpha: Double)

private val HEX = Regex("#[0-9a-fA-F]{6}")
private val INTEGER = Regex("-?(0|[1-9][0-9]*)")

private fun JsonElement.obj() = this as? JsonObject ?: throw IllegalArgumentException("not an object")
private fun JsonObject.need(key: String) = this[key] ?: throw IllegalArgumentException("$key is missing")
private fun JsonElement.integer(): Int {
    require(this is JsonPrimitive && !isString && INTEGER.matches(content))
    return int
}
private fun JsonElement.flag(): Boolean {
    require(this is JsonPrimitive && !isString && (content == "true" || content == "false"))
    return boolean
}
private fun JsonElement.pair(): Pair<Int, Int> {
    require(this is JsonArray && size == 2)
    return this[0].integer() to this[1].integer()
}
private fun JsonObject.colors(): Map<String, String> = mapValues { (_, value) ->
    require(value is JsonPrimitive && value.isString && HEX.matches(value.content))
    value.content
}

private fun petGrid(palette: Map<String, String>, value: JsonElement, width: Int, height: Int, keys: String = "."): List<String> {
    require(value is JsonArray && value.size == height)
    val grid = value.map {
        require(it is JsonPrimitive && it.isString && it.content.length == width)
        it.content
    }
    require(grid.all { row -> row.all { it in keys || it.toString() in palette } })
    return grid
}

private fun petRuns(grid: List<String>, palette: Map<String, String>, accent: Boolean = false) = buildList {
    grid.forEachIndexed { y, row ->
        var x = 0
        while (x < row.length) {
            var end = x
            while (end < row.length && row[end] == row[x]) end++
            if (row[x] != '.') add(PetRun(if (accent && row[x] == 'A') null else palette.getValue(row[x].toString()), x, y, end - x))
            x = end
        }
    }
}

/** The same checks and run order as parse_pets in scripts/asb-native.py; any problem throws. */
fun parsePets(text: String): Pets {
    val data = Json.parseToJsonElement(text).obj()
    require(data.need("version").integer() == 1)
    val letter = data.need("envelope").obj()
    require(letter.need("width").integer() == 8 && letter.need("height").integer() == 6)
    val letterPalette = letter.need("palette").obj().colors()
    val envelope = petRuns(petGrid(letterPalette, letter.need("grid"), 8, 6, ".A"), letterPalette, accent = true)
    val items = data.need("pets").obj()
    val pets = PET_NAMES.drop(1).associateWith { name ->
        val item = items.need(name).obj()
        val width = item.need("width").integer()
        val height = item.need("height").integer()
        val palette = item.need("palette").obj().colors()
        val anchor = item.need("anchor").pair()
        val mirror = item.need("mirror").flag()
        val front = item.need("envelopeFront").flag()
        val fps = item.need("walkFps").integer()
        require(fps >= 1)
        val frameItems = item.need("frames").obj()
        val frames = PET_FRAMES.associateWith { frame ->
            val value = frameItems.need(frame).obj()
            val grid = petGrid(palette, value.need("grid"), width, height)
            val overValue = value.need("over")
            require(overValue is JsonArray)
            val over = overValue.map { it.pair() }
            require(over.all { (x, y) -> x in 0 until width && y in 0 until height })
            var right = petRuns(grid, palette)
            var left = right.map { it.copy(x = width - it.x - it.width) }
            val heldValue = value.need("envelope")
            val held = if (heldValue is JsonNull) null else heldValue.pair().let { (ex, ey) ->
                listOf(ex to ey, if (mirror) width - 8 - ex to ey else ex to ey)
            }
            if (held != null) {
                val letters = held.map { (hx, hy) -> envelope.map { it.copy(x = hx + it.x, y = hy + it.y) } }
                if (front) {
                    right = right + letters[0] + over.map { (x, y) -> PetRun(palette.getValue(grid[y][x].toString()), x, y, 1) }
                    left = left + letters[1] + over.map { (x, y) -> PetRun(palette.getValue(grid[y][x].toString()), width - 1 - x, y, 1) }
                } else {
                    right = letters[0] + right
                    left = letters[1] + left
                }
            }
            PetFrame(listOf(right, if (mirror) left else right), held)
        }
        Pet(width, height, anchor, mirror, fps, frames)
    }
    return Pets(envelope, pets)
}

private object PetAsset {
    private var loaded = false
    private var pets: Pets? = null

    @Synchronized
    fun load(context: Context): Pets? {
        if (!loaded) {
            // A broken file means no pets: the light plays and the tiles show names only.
            pets = try {
                context.assets.open("pets/pets.json").bufferedReader().use { parsePets(it.readText()) }
            } catch (_: Exception) { null }
            loaded = true
        }
        return pets
    }
}

/** The app pets, parsed once off the main thread; null while loading or when the file is broken. */
@Composable
fun rememberPets(): State<Pets?> {
    val context = LocalContext.current.applicationContext
    return produceState(null, context) { value = withContext(Dispatchers.IO) { PetAsset.load(context) } }
}

fun petRound(value: Double) = floor(value + .5).toInt()
fun petSign(value: Double) = if (value > 0) 1 else if (value < 0) -1 else 0
fun petStop(pet: Pet, scale: Double, receiverX: Double, direction: Int) =
    receiverX - direction * (if (scale > 1) 12.0 else 12.0 + pet.reach)
fun petWalkMs(distance: Double) =
    if (distance != 0.0) distance / max(min(300.0, max(120.0, distance / 1.1)), distance / 2) * 1000 else 0.0

fun petJumpY(y0: Double, y1: Double, height: Double, u: Double): Double {
    val top = min(y0, y1) - height
    val a = y0 - top
    val k = (y1 - y0) + 2 * a + 2 * sqrt(a * (y1 - top))
    return y0 + (y1 - y0) * u - k * u * (1 - u)
}

fun petPlan(pet: Pet, scale: Double, sender: PetPoint, receiver: PetPoint): PetPlan {
    val direction = petSign(receiver.x - sender.x).takeIf { it != 0 } ?: -1
    val stop = petStop(pet, scale, receiver.x, direction)
    val sameRow = abs(receiver.floor - sender.floor) < 1
    val steps = mutableListOf("rise" to 380.0)
    if (sameRow) steps += "walk" to petWalkMs(abs(stop - sender.x))
    else {
        if (abs(stop - sender.x) > 14 * scale) {
            steps += "walk" to petWalkMs(abs(stop - petSign(stop - sender.x) * 14 * scale - sender.x))
        }
        steps += listOf("crouch" to 80.0, "jump" to min(620.0, max(300.0, 260 + .5 * abs(receiver.floor - sender.floor))),
            "land" to 80.0)
    }
    steps += listOf("windup" to 120.0, "toss" to 240.0, "hop" to 160.0, "dive" to 320.0)
    val phases = mutableListOf<PetPhase>()
    var t = 0.0
    for ((name, duration) in steps) if (duration > 0) {
        phases += PetPhase(name, t, t + duration)
        t += duration
    }
    return PetPlan(direction, sameRow, phases, phases.first { it.name == "toss" }.end, t + 200)
}

fun petPose(pet: Pet, scale: Double, plan: PetPlan, t: Double, sender: PetPoint, receiver: PetPoint): PetPose? {
    val phase = plan.phases.firstOrNull { it.start <= t && t < it.end } ?: return null
    val lt = t - phase.start
    val u = lt / (phase.end - phase.start)
    val d = plan.direction
    val stop = petStop(pet, scale, receiver.x, d)
    val jx = if (abs(stop - sender.x) > 14 * scale) stop - petSign(stop - sender.x) * 14 * scale else sender.x
    val first = petSign(stop - sender.x).takeIf { it != 0 } ?: d
    val jumpFace = petSign(stop - jx).takeIf { it != 0 } ?: d
    val h = pet.height
    val fs = sender.floor
    val fr = receiver.floor
    return when (phase.name) {
        "rise" -> {
            val back = 1 + 2.4 * (u - 1).pow(3) + 1.4 * (u - 1).pow(2)
            PetPose(if (u < .7) "air" else "stand", sender.x, fs + h * scale * (1 - back), first, fs)
        }
        "walk" -> {
            val x1 = if (plan.sameRow) stop else jx
            PetPose(PET_FRAMES[1 + Math.floorMod(floor(lt * pet.walkFps / 1000).toInt(), 4)],
                sender.x + (x1 - sender.x) * u, fs, first, null)
        }
        "crouch" -> PetPose("crouch", jx, fs, jumpFace, null)
        "jump" -> {
            val height = max(0.0, min(9 * scale, min(fs, fr) - h * scale - 2))
            PetPose(if (Math.floorMod(floor(lt / 90).toInt(), 2) == 1) "air2" else "air", jx + (stop - jx) * u,
                petJumpY(fs, fr, height, u), jumpFace, null)
        }
        // From the toss on, the paws are empty: the envelope never shows in the pet again.
        "land" -> PetPose("crouch", stop, fr, d, null)
        "windup" -> PetPose("toss", stop, fr, d, null)
        "toss" -> PetPose("release", stop, fr, d, null)
        "hop" -> PetPose("release", stop, fr - 4 * scale * sin(PI * u), d, null)
        else -> PetPose("release", stop, fr + h * scale * u.pow(3), d, fr)
    }
}

fun petBox(pet: Pet, scale: Double, frame: String, x: Double, y: Double, face: Int): PetBox {
    val flip = pet.mirror && face < 0
    val ax = if (flip) pet.width - pet.anchor.first else pet.anchor.first
    return PetBox(pet.frames.getValue(frame).runs[if (flip) 1 else 0], petRound(x - ax * scale),
        petRound(y - pet.height * scale), flip)
}

fun petEnvelope(pet: Pet, scale: Double, plan: PetPlan, t: Double, receiver: PetPoint): Pair<Int, Int>? {
    val toss = plan.phases.first { it.name == "toss" }
    if (t < toss.start || t >= toss.end) return null
    val d = plan.direction
    val box = petBox(pet, scale, "toss", petStop(pet, scale, receiver.x, d), receiver.floor, d)
    val (ex, ey) = pet.frames.getValue("toss").envelope!![if (box.flip) 1 else 0]
    val x0 = box.left + ex * scale
    val y0 = box.top + ey * scale
    val x1 = receiver.x - 4 * scale
    val y1 = receiver.y - 3 * scale
    val cx = (x0 + x1) / 2
    val cy = min(y0, y1) - 9 * scale
    val p = 1 - (1 - (t - toss.start) / (toss.end - toss.start)).pow(2)
    val q = 1 - p
    return petRound(q * q * x0 + 2 * q * p * cx + p * p * x1) to petRound(q * q * y0 + 2 * q * p * cy + p * p * y1)
}

private val GROUND_ANGLES = listOf(200, 250, 290, 340)
private val ICON_ANGLES = (0 until 360 step 45).toList()

fun petParticles(pet: Pet, scale: Double, plan: PetPlan, t: Double, sender: PetPoint, receiver: PetPoint): List<PetParticle> {
    val dive = plan.phases.first { it.name == "dive" }.start
    val bursts = listOf(
        Triple(sender.x to sender.floor - 1, 0.0, GROUND_ANGLES),
        Triple(receiver.x to receiver.y, plan.ta, ICON_ANGLES),
        Triple(petStop(pet, scale, receiver.x, plan.direction) to receiver.floor - 1, dive, GROUND_ANGLES),
    )
    val particles = mutableListOf<PetParticle>()
    for ((center, start, angles) in bursts) {
        val v = (t - start) / 360
        if (v < 0 || v >= 1) continue
        val radius = (5 + 11 * (1 - (1 - v).pow(3))) * scale / 2
        val alpha = if (v < .5) 1.0 else 1 - (v - .5) / .5
        for (angle in angles) {
            val radians = Math.toRadians(angle.toDouble())
            particles += PetParticle(petRound(center.first + radius * cos(radians) - 1), petRound(center.second + radius * sin(radians) - 1), alpha)
        }
    }
    return particles
}

/** Card index (0 sender, 1 receiver) to tint alpha. */
fun petTints(plan: PetPlan, t: Double): Map<Int, Double> {
    val tints = mutableMapOf<Int, Double>()
    for ((index, start, end) in listOf(Triple(0, 0.0, 520.0), Triple(1, plan.ta - 120, plan.end))) {
        if (start <= t && t < end) {
            val alpha = max(0.0, minOf(1.0, (t - start) / 120, (end - t) / 240))
            if (alpha > 0) tints[index] = alpha
        }
    }
    return tints
}

/** The Settings tile hop after a choice: (frame, y offset in dp, negative is up), or null at rest. */
fun petTilePose(t: Double): Pair<String, Double>? = when {
    t < 0 -> null
    t < 80 -> "crouch" to 0.0
    t < 240 -> (if (t - 80 < 90) "air" else "air2") to -4 * 2 * sin(PI * (t - 80) / 160)
    t < 320 -> "crouch" to 0.0
    else -> null
}

enum class MessagePlay { PET, LIGHT }

/** A pet carries a message only when both cards are in the list; else the light rule of the list stays. */
fun messagePlay(pet: String, petsLoaded: Boolean, reducedMotion: Boolean, startOutside: Boolean, endOutside: Boolean) =
    if (pet in PET_NAMES.drop(1) && petsLoaded && !reducedMotion && !startOutside && !endOutside) MessagePlay.PET else MessagePlay.LIGHT

/**
 * The one pet painter of the list, the tiles, and the stage: a frame with its feet at [pose], the flying envelope, and
 * the particles, in dp from the canvas top-left. One sprite pixel is a whole number of device pixels.
 */
fun DrawScope.drawPet(
    pets: Pets, pet: Pet, scale: Double, color: Color, pose: PetPose?, envelope: Pair<Int, Int>? = null,
    particles: List<PetParticle> = emptyList(),
) {
    val d = density.toDouble()
    val p = max(1, petRound(scale * d))
    fun paint(runs: List<PetRun>, left: Int, top: Int) {
        for (run in runs) drawRect(run.color?.let(::hexColor) ?: color, Offset((left + run.x * p).toFloat(), (top + run.y * p).toFloat()),
            Size((run.width * p).toFloat(), p.toFloat()))
    }
    if (pose != null) {
        val box = petBox(pet, scale, pose.frame, pose.x, pose.y, pose.face)
        val ax = if (box.flip) pet.width - pet.anchor.first else pet.anchor.first
        val left = petRound(pose.x * d) - ax * p
        val top = petRound(pose.y * d) - pet.height * p
        val clip = pose.clip
        if (clip != null) clipRect(bottom = petRound(clip * d).toFloat()) { paint(box.runs, left, top) }
        else paint(box.runs, left, top)
    }
    if (envelope != null) paint(pets.envelope, petRound(envelope.first * d), petRound(envelope.second * d))
    val size = max(1, petRound(2 * d)).toFloat()
    for (particle in particles) drawRect(color.copy(alpha = particle.alpha.toFloat()),
        Offset(petRound(particle.x * d).toFloat(), petRound(particle.y * d).toFloat()), Size(size, size))
}

/** One frame of a pet message at [t] ms, from the card ends now. */
fun DrawScope.drawPetFlight(
    pets: Pets, pet: Pet, scale: Double, plan: PetPlan, t: Double, sender: PetPoint, receiver: PetPoint, color: Color,
) = drawPet(pets, pet, scale, color, petPose(pet, scale, plan, t, sender, receiver),
    petEnvelope(pet, scale, plan, t, receiver), petParticles(pet, scale, plan, t, sender, receiver))
