package local.asb.companion

import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.json.*
import local.asb.companion.ui.*
import org.junit.Assert.*
import org.junit.Test

class PetMotionTest {
    private val pets = parsePets(File("src/main/assets/pets/pets.json").readText())
    private var compared = 0

    private fun sha(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray())
        .joinToString("") { "%02x".format(it) }
    private fun runs(runs: List<PetRun>) = runs.joinToString("") { "${it.color ?: "A"},${it.x},${it.y},${it.width};" }
    private fun point(value: JsonElement) = value.jsonArray.let { PetPoint(it[0].jsonPrimitive.double, it[1].jsonPrimitive.double, it[2].jsonPrimitive.double) }
    private fun json(value: Any?): JsonElement = when (value) {
        null -> JsonNull
        is String -> JsonPrimitive(value)
        is Boolean -> JsonPrimitive(value)
        is Number -> JsonPrimitive(value)
        is Map<*, *> -> JsonObject(value.entries.associate { it.key.toString() to json(it.value) })
        is List<*> -> JsonArray(value.map(::json))
        else -> error("Unsupported fixture value: $value")
    }
    private fun compare(path: String, expected: JsonElement, actual: JsonElement) {
        when (expected) {
            is JsonObject -> {
                assertEquals(path, expected.keys, actual.jsonObject.keys)
                expected.forEach { (key, value) -> compare("$path.$key", value, actual.jsonObject.getValue(key)) }
            }
            is JsonArray -> {
                assertEquals(path, expected.size, actual.jsonArray.size)
                expected.forEachIndexed { i, value -> compare("$path[$i]", value, actual.jsonArray[i]) }
            }
            else -> {
                compared++
                val primitive = expected as? JsonPrimitive
                if (primitive != null && !primitive.isString && primitive.doubleOrNull != null) {
                    if (primitive.content.contains('.')) assertEquals(path, primitive.double, actual.jsonPrimitive.double, 1e-6)
                    else assertEquals(path, primitive.double, actual.jsonPrimitive.double, 0.0)
                } else assertEquals(path, expected, actual)
            }
        }
    }

    @Test fun boardFixtureMatchesEveryValue() {
        val fixture = Json.parseToJsonElement(javaClass.getResource("/pet-motion.json")!!.readText()).jsonObject
        compare("envelopeSha256", fixture.getValue("envelopeSha256"), json(sha(runs(pets.envelope))))
        var cases = 0
        var samples = 0
        for ((name, entryValue) in fixture.getValue("pets").jsonObject) {
            val pet = pets.pets.getValue(name)
            val entry = entryValue.jsonObject
            val text = PET_FRAMES.joinToString("") { frame -> pet.frames.getValue(frame).runs.joinToString("") { runs(it) + "|" } }
            compare("$name.runsSha256", entry.getValue("runsSha256"), json(sha(text)))
            for ((caseIndex, caseValue) in entry.getValue("cases").jsonArray.withIndex()) {
                cases++
                val case = caseValue.jsonObject
                val scale = case.getValue("scale").jsonPrimitive.double
                val sender = point(case.getValue("sender"))
                val receiver = point(case.getValue("receiver"))
                val plan = petPlan(pet, scale, sender, receiver)
                val path = "$name.case[$caseIndex]"
                compare("$path.plan", case.getValue("plan"), json(mapOf("direction" to plan.direction, "sameRow" to plan.sameRow,
                    "phases" to plan.phases.map { listOf(it.name, it.start, it.end) }, "ta" to plan.ta, "end" to plan.end)))
                for (sampleValue in case.getValue("samples").jsonArray) {
                    samples++
                    val sample = sampleValue.jsonObject
                    val t = sample.getValue("t").jsonPrimitive.double
                    val pose = petPose(pet, scale, plan, t, sender, receiver)
                    val box = pose?.let { petBox(pet, scale, it.frame, it.x, it.y, it.face) }
                    val envelope = petEnvelope(pet, scale, plan, t, receiver)
                    compare("$path.t=$t", sampleValue, json(mapOf("t" to t,
                        "pose" to pose?.let { mapOf("frame" to it.frame, "x" to it.x, "y" to it.y, "face" to it.face, "clip" to it.clip) },
                        "box" to box?.let { mapOf("left" to it.left, "top" to it.top, "flip" to it.flip) },
                        "envelope" to envelope?.let { listOf(it.first, it.second) },
                        "particles" to petParticles(pet, scale, plan, t, sender, receiver).map { listOf(it.x, it.y, it.alpha) },
                        "tints" to petTints(plan, t))))
                }
            }
        }
        assertEquals(12, cases)
        println("Pet fixture: $cases cases, $samples samples, $compared compared values")
    }

    @Test fun tileHopUsesTheBoardFramesAndOffsets() {
        for ((t, frame, y) in listOf(Triple(40.0, "crouch", 0.0), Triple(160.0, "air", -8.0),
            Triple(200.0, "air2", -5.657), Triple(280.0, "crouch", 0.0))) {
            assertEquals(frame, petTilePose(t)!!.first)
            assertEquals(y, petTilePose(t)!!.second, .001)
        }
        assertNull(petTilePose(330.0))
    }

    @Test fun messageChoiceCoversEveryCombination() {
        for (pet in PET_NAMES + "invalid") for (loaded in listOf(false, true)) for (reduced in listOf(false, true))
            for (senderOutside in listOf(false, true)) for (receiverOutside in listOf(false, true)) {
                val expected = if (pet in PET_NAMES.drop(1) && loaded && !reduced && !senderOutside && !receiverOutside)
                    MessagePlay.PET else MessagePlay.LIGHT
                assertEquals("$pet,$loaded,$reduced,$senderOutside,$receiverOutside", expected,
                    messagePlay(pet, loaded, reduced, senderOutside, receiverOutside))
            }
    }

    @Test fun invalidAssetsAreRejected() {
        val text = File("src/main/assets/pets/pets.json").readText()
        val data = Json.parseToJsonElement(text).jsonObject
        val cat = data.getValue("pets").jsonObject.getValue("cat").jsonObject
        val variants = listOf("{", JsonObject(data + ("version" to JsonPrimitive(2))).toString(),
            JsonObject(data + ("version" to JsonPrimitive(true))).toString()) + listOf(
            cat - "anchor", cat + ("mirror" to JsonPrimitive(1)), cat + ("walkFps" to JsonPrimitive(0)),
            cat + ("anchor" to JsonArray(listOf(JsonPrimitive(1), JsonPrimitive(1.5)))),
            cat + ("palette" to JsonObject(mapOf("X" to JsonPrimitive("red")))),
            cat + ("frames" to JsonObject(cat.getValue("frames").jsonObject - "air2")),
        ).map { changed -> JsonObject(data + ("pets" to JsonObject(data.getValue("pets").jsonObject + ("cat" to JsonObject(changed))))).toString() }
        for (variant in variants) {
            try { parsePets(variant); fail("Accepted a broken asset") } catch (_: IllegalArgumentException) { }
        }
    }
}
