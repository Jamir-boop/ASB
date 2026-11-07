package local.asb.companion.data

import java.math.BigDecimal
import java.math.RoundingMode
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonTransformingSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

val AsbJson = Json { ignoreUnknownKeys = true }

private val jsonNumber = Regex("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")
private val longRange = BigDecimal(Long.MIN_VALUE)..BigDecimal(Long.MAX_VALUE)

// ASB times come from Node mtimeMs and can be fractional, so floor them to whole milliseconds.
internal fun floorMillis(value: JsonPrimitive): Long? {
    if (value.isString || !jsonNumber.matches(value.content)) return null
    val number = BigDecimal(value.content)
    // Check the range before setScale so a huge exponent cannot expand into a huge integer.
    return if (number in longRange) number.setScale(0, RoundingMode.FLOOR).longValueExact() else null
}

object MillisSerializer : KSerializer<Long> {
    override val descriptor = PrimitiveSerialDescriptor("local.asb.companion.Millis", PrimitiveKind.LONG)

    override fun deserialize(decoder: Decoder): Long {
        if (decoder !is JsonDecoder) return decoder.decodeLong()
        val value = decoder.decodeJsonElement() as? JsonPrimitive
        return value?.let(::floorMillis) ?: throw SerializationException("Invalid milliseconds")
    }

    override fun serialize(encoder: Encoder, value: Long) = encoder.encodeLong(value)
}

@Serializable
data class Dashboard(
    @Serializable(with = MillisSerializer::class)
    val generatedAtMs: Long = 0,
    val performance: JsonObject = JsonObject(emptyMap()),
    val persistentUnread: Boolean = true,
    val pinnedOrder: List<String> = emptyList(),
    val providers: List<Provider> = emptyList(),
    val refreshIntervalMs: Long = 5000,
    val summary: JsonObject = JsonObject(emptyMap()),
    val threads: List<Thread> = emptyList(),
    @Serializable(with = MessageListSerializer::class)
    val messages: List<Message> = emptyList(),
    // Raw, so a bad palette cannot fail the whole dashboard; Palette.parse reads it.
    val palette: JsonElement? = null,
)

@Serializable
data class Message(
    val from: String = "",
    val to: String = "",
    @Serializable(with = MillisSerializer::class) val atMs: Long = 0,
)

private object MessageListSerializer : JsonTransformingSerializer<List<Message>>(ListSerializer(Message.serializer())) {
    override fun transformDeserialize(element: JsonElement): JsonElement = JsonArray(
        (element as? JsonArray).orEmpty().mapNotNull { entry ->
            val message = entry as? JsonObject ?: return@mapNotNull null
            if ((message["from"] as? JsonPrimitive)?.isString != true ||
                (message["to"] as? JsonPrimitive)?.isString != true) return@mapNotNull null
            val milliseconds = (message["atMs"] as? JsonPrimitive)?.let(::floorMillis) ?: return@mapNotNull null
            JsonObject(message + ("atMs" to JsonPrimitive(milliseconds)))
        }
    )
}

@Serializable
data class Thread(
    val id: String = "",
    val externalId: String = "",
    val sourceId: String = "",
    val sourceLabel: String = "",
    val sourceNumber: Int = 0,
    val sourceCount: Int = 0,
    val sourceColor: String = "",
    val sourceShowMarker: Boolean = true,
    val provider: String = "",
    val providerLabel: String = "",
    val title: String = "",
    val cwd: String = "",
    val projectName: String = "",
    val archived: Boolean = false,
    @Serializable(with = MillisSerializer::class)
    val updatedAtMs: Long = 0,
    val subagentCount: Int = 0,
    val state: String = "unknown",
    val reason: String = "",
    @Serializable(with = MillisSerializer::class)
    val workingSinceMs: Long = 0,
    val nativeUnread: Boolean? = null,
    val readStatus: String = "",
    val questionPending: Boolean = false,
    val actionRequired: Boolean = false,
    // An older engine sends none.
    val actionAttention: Boolean? = null,
    val lastOutcome: String = "",
    // A Claude Code process ended during a task (an Unknown row); an older engine sends none.
    val processEnded: Boolean = false,
    @Serializable(with = MillisSerializer::class)
    val failedAtMs: Long = 0,
    @Serializable(with = MillisSerializer::class)
    val completionAtMs: Long = 0,
    @Serializable(with = MillisSerializer::class)
    val limitResetsAtMs: Long = 0,
    val canOpen: Boolean = false,
    val appDeepLink: String = "",
    val discardResult: Boolean = false,
    val pinIndex: Int = -1,
    val pinned: Boolean = false,
    val manualUnread: Boolean = false,
    val questionAttention: Boolean = false,
    val nativeAttention: Boolean = false,
    val failedAttention: Boolean = false,
    val completionAttention: Boolean = false,
    val retainedUnread: Boolean = false,
    val retainedUnreadSource: String = "",
    val drawer: Boolean = false,
    // The start of an active mute, else 0.
    @Serializable(with = MillisSerializer::class) val mutedAtMs: Long = 0,
    // An active mute; an older engine sends none.
    val muted: Boolean = false,
    val unread: Boolean = false,
    // The unread mark comes from a failed or usage-limit stop; an older engine sends none.
    val alert: Boolean = false,
    val pending: Boolean = false,
    val pendingSource: String = "",
    val machineId: String = "",
    val machineName: String = "",
    val remote: Boolean = false,
    val surface: String = "app",
    val globalId: String = "",
) {
    /** The ID that is the same on every engine of a machine group; older PCs send no globalId. */
    val key: String get() = globalId.ifEmpty { id }
}

/** The saved attention bits of a row and its result times; a time of 0 is not known. */
@Serializable
data class Mark(val bits: Int, val doneAtMs: Long = 0, val failedAtMs: Long = 0)

@Serializable
data class Provider(
    val id: String = "",
    val label: String = "",
    val status: String = "",
    val message: String = "",
)

@Serializable
data class Hello(
    val api: Int = 0,
    val asbVersion: String = "",
    val deviceId: String = "",
    val serverName: String = "",
    /** The addresses the gateway listens on now; empty from a PC before version 2 links. */
    val addresses: List<Endpoint> = emptyList(),
    val machineId: String = "",
    val engines: List<Engine> = emptyList(),
)

/** Another ASB engine of the paired PC's machine group (hello `engines`); the phone token is the same on all. */
@Serializable
data class Engine(
    val machineId: String = "",
    val name: String = "",
    val port: Int = 0,
    val fingerprint: String = "",
    val addresses: List<Endpoint> = emptyList(),
)

@Serializable
data class PairReply(
    val deviceId: String = "",
    val token: String = "",
    val serverName: String = "",
    val asbVersion: String = "",
    val api: Int = 0,
)

@Serializable
data class ErrorReply(val error: String = "", val detail: String = "")

private val hexColor = Regex("#[0-9a-fA-F]{6}")

// Port of luminance.
fun luminance(color: String): Double = listOf(1 to .2126, 3 to .7152, 5 to .0722).sumOf { (start, weight) ->
    val value = color.substring(start, start + 2).toInt(16) / 255.0
    (if (value <= .04045) value / 12.92 else Math.pow((value + .055) / 1.055, 2.4)) * weight
}

// Port of contrast.
fun contrast(first: String, second: String): Double {
    val a = luminance(first)
    val b = luminance(second)
    return (maxOf(a, b) + .05) / (minOf(a, b) + .05)
}

// CIE L* (D65) from the relative luminance that contrast uses.
fun lightness(color: String): Double {
    val y = luminance(color)
    return if (y > 216.0 / 24389) 116 * Math.cbrt(y) - 16 else 24389.0 / 27 * y
}

// Port of mix_color. Math.rint rounds half to even, as Python round does.
fun mixColor(background: String, foreground: String, fraction: Double): String = "#" + listOf(1, 3, 5).joinToString("") { start ->
    val value = background.substring(start, start + 2).toInt(16) * (1 - fraction) +
        foreground.substring(start, start + 2).toInt(16) * fraction
    Math.rint(value).toInt().toString(16).padStart(2, '0')
}

// Port of display_source_color: "" when no mix toward white reaches 3:1 on every surface.
fun displaySourceColor(color: String, surfaces: List<String>): String {
    for (percent in 0..100) {
        val displayed = mixColor(color, "#ffffff", percent / 100.0)
        if (surfaces.all { contrast(displayed, it) >= 3 }) return displayed
    }
    return ""
}

// Port of edge_color: the weakest mix of color into base, from fraction up, with 3:1 contrast on each surface.
fun edgeColor(base: String, color: String, fraction: Double, surfaces: List<String>): String {
    for (percent in Math.rint(fraction * 100).toInt()..100) {
        val value = mixColor(base, color, percent / 100.0)
        if (surfaces.all { contrast(value, it) >= 3 }) return value
    }
    return color
}

// Port of contrast_floor: the weakest mix of ink into color with the minimum contrast on the surface.
fun contrastFloor(color: String, ink: String, surface: String, minimum: Double = 4.5): String {
    for (percent in 0..100) {
        val value = mixColor(color, ink, percent / 100.0)
        if (contrast(value, surface) >= minimum) return value
    }
    return ink
}

/**
 * Port of accent_guard: a data color near the accent in hue (both with OKLCH chroma 0.04 or more, hues less than 30° apart) and
 * under 1.5:1 on it moves only its OKLCH lightness, away from the accent lightness in 0.005 steps, until it has 2:1 on the accent
 * and 3:1 on the background; at 0 or 1 it tries the other way, and with no such lightness it stays [color].
 */
fun accentGuard(color: String, accent: String, background: String): String {
    val (lightness, a, b) = oklab(color)
    val (accentLightness, aa, ab) = oklab(accent)
    val chroma = Math.hypot(a, b)
    val hue = degrees360(Math.toDegrees(Math.atan2(b, a)))
    val distance = Math.abs(degrees360(hue - degrees360(Math.toDegrees(Math.atan2(ab, aa))) + 180) - 180)
    if (chroma < .04 || Math.hypot(aa, ab) < .04 || distance >= 30 || contrast(color, accent) >= 1.5) return color
    val direction = if (lightness <= accentLightness) -1 else 1
    for (sign in listOf(direction, -direction)) {
        var step = lightness
        while (step > 0 && step < 1) {
            step = (step + sign * .005).coerceIn(0.0, 1.0)
            val candidate = oklchColor(step, chroma, hue)
            if (contrast(candidate, accent) >= 2 && contrast(candidate, background) >= 3) return candidate
        }
    }
    return color
}

// Python's x % 360 for a double.
private fun degrees360(value: Double): Double = (value % 360 + 360) % 360

// Text keeps 4.5:1: the first mix of color toward text that has it on every surface.
fun readableColor(color: String, text: String, surfaces: List<String>): String {
    for (percent in 0..100) {
        val value = mixColor(color, text, percent / 100.0)
        if (surfaces.all { contrast(value, it) >= 4.5 }) return value
    }
    return text
}

// Port of highlight_color.
fun highlightColor(background: String, accent: String): String = mixColor(background, accent, .15)

// Port of quiet_color: the first mix of color into the background, from fraction up, with 4.5:1 on both surfaces.
fun quietColor(background: String, color: String, fraction: Double, highlight: String): Pair<String, Double> {
    for (percent in Math.rint(fraction * 100).toInt()..100) {
        val mixed = mixColor(background, color, percent / 100.0)
        if (contrast(mixed, background) >= 4.5 && contrast(mixed, highlight) >= 4.5) return mixed to percent / 100.0
    }
    return color to 1.0
}

/**
 * The quiet title and caption: when the title is less than 10 L* above the caption, the caption fraction goes down
 * one percent at a time to its 4.5:1 floor, then the title fraction goes up, until the step is 10 or more.
 */
fun quietTones(background: String, text: String, caption: String, captionFraction: Double, highlight: String): Pair<String, String> {
    val (title, titleFraction) = quietColor(background, text, .67, highlight)
    val (quiet, fraction) = quietColor(background, caption, captionFraction, highlight)
    fun step(first: String, second: String) = lightness(first) - lightness(second) >= 10
    if (step(title, quiet)) return title to quiet
    val floor = quietColor(background, caption, 0.0, highlight).second
    var lowered = quiet
    for (percent in Math.rint(fraction * 100).toInt() downTo Math.rint(floor * 100).toInt()) {
        lowered = mixColor(background, caption, percent / 100.0)
        if (step(title, lowered)) return title to lowered
    }
    var raised = title
    for (percent in Math.rint(titleFraction * 100).toInt()..100) {
        raised = mixColor(background, text, percent / 100.0)
        if (step(raised, lowered)) break
    }
    return raised to lowered
}

// Port of limited_color.
fun limitedColor(background: String, text: String): Pair<String, Double> = quietColor(background, text, 0.0, background)

/** The PC window palette (dashboard `palette`), with the values that the desktop derives from it. */
data class Palette(
    val mode: String = "gnome",
    val background: String = "#222226",
    val text: String = "#ffffff",
    val accent: String = "#78aeed",
    val muted: String = mixColor(background, text, .72),
    val divider: String = mixColor(background, text, .3),
    val success: String = "#8ff0a4",
    val warning: String = "#f8e45c",
) {
    val custom: Boolean get() = mode == "custom"
    // As set_palette: Custom mixes the accent in, GNOME uses the foreground at 7%.
    val highlight: String = if (mode == "custom") highlightColor(background, accent) else mixColor(background, text, .07)
    private val quiet: Pair<String, String> =
        if (mode == "custom") quietTones(background, text, muted, .85, highlight) else quietTones(background, text, text, .5, highlight)
    val quietTitle: String = quiet.first
    val quietCaption: String = quiet.second
    val limited: String = limitedColor(background, text).first
    val limitedPressed: String = quietColor(background, text, 0.0, highlight).first

    fun toJson(): String = buildJsonObject {
        put("mode", mode)
        put("colors", buildJsonObject {
            for ((key, value) in listOf("background" to background, "text" to text, "accent" to accent,
                "muted" to muted, "divider" to divider, "success" to success, "warning" to warning)) put(key, value)
        })
    }.toString()

    companion object {
        /** null when the value is not a palette object; a bad mode or color takes the fallback value. */
        fun parse(value: JsonElement?): Palette? {
            val palette = value as? JsonObject ?: return null
            val colors = palette["colors"] as? JsonObject
            fun color(key: String): String? = (colors?.get(key) as? JsonPrimitive)
                ?.takeIf { it.isString && hexColor.matches(it.content) }?.content?.lowercase()
            val fallback = Palette()
            val mode = (palette["mode"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val background = color("background") ?: fallback.background
            val text = color("text") ?: fallback.text
            return Palette(
                mode = if (mode == "custom") "custom" else "gnome",
                background = background,
                text = text,
                accent = color("accent") ?: fallback.accent,
                muted = color("muted") ?: mixColor(background, text, .72),
                divider = color("divider") ?: mixColor(background, text, .3),
                success = color("success") ?: fallback.success,
                warning = color("warning") ?: fallback.warning,
            )
        }
    }
}
