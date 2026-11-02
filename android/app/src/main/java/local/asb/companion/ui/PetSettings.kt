package local.asb.companion.ui

import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import local.asb.companion.data.Message
import local.asb.companion.data.Thread
import local.asb.companion.data.mixColor

@Composable
internal fun rememberReducedMotion(): Boolean {
    val resolver = LocalContext.current.contentResolver
    fun read() = try { Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }
        catch (_: SecurityException) { false }
    var reduced by remember(resolver) { mutableStateOf(read()) }
    DisposableEffect(resolver) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) { reduced = read() }
        }
        resolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, observer)
        onDispose { resolver.unregisterContentObserver(observer) }
    }
    return reduced
}

private val SAMPLE_CARDS = listOf(
    Thread(id = "sample-left", provider = "codex", projectName = "docs-site", title = "Write the release notes for 2.4", state = "idle"),
    Thread(id = "sample-right", provider = "claude", projectName = "billing", title = "Check the retry limits", state = "idle"),
)

/** Phone-local choices; no session or engine data enters this preview. */
@Composable
internal fun PetSettings(pet: String, onChoice: (String) -> Unit) {
    val palette = LocalPalette.current
    val pets by rememberPets()
    val reducedMotion = rememberReducedMotion()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var choice by remember { mutableIntStateOf(0) }
    // Only a tap starts a tile hop. The first screen draw leaves every tile still.
    var tileTime by remember { mutableStateOf<Double?>(null) }
    LaunchedEffect(choice, reducedMotion, lifecycle) {
        tileTime = null
        if (choice == 0 || reducedMotion) return@LaunchedEffect
        var played = false
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            // A lifecycle resume must not repeat a tap.
            if (played) return@repeatOnLifecycle
            played = true
            try {
                val start = withFrameNanos { it }
                val end = if (pet == "off") 700.0 else 320.0
                do {
                    val t = withFrameNanos { (it - start) / 1_000_000.0 }
                    tileTime = t
                } while (t < end)
            } finally { tileTime = null }
        }
    }
    Text("Pets", style = MaterialTheme.typography.labelLarge)
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val width = minOf(112.dp, (maxWidth - 24.dp) / 4)
        Row(Modifier.selectableGroup(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PET_NAMES.forEach { value ->
                val selected = pet == value
                val name = value.replaceFirstChar { it.uppercase() }
                val shape = RoundedCornerShape(8.dp)
                val background = hexColor(mixColor(palette.background, palette.text, .08))
                val outline = hexColor(mixColor(palette.background, palette.text, .15))
                val accent = hexColor(palette.accent)
                Box(Modifier.width(width).height(92.dp).clip(shape).background(background)
                    .border(if (selected) 2.dp else 1.dp, if (selected) accent else outline, shape)
                    .selectable(selected, role = Role.RadioButton, onClick = { onChoice(value); choice++ })
                    .semantics { contentDescription = name }) {
                    val messageColor = MaterialTheme.colorScheme.primary
                    Canvas(Modifier.matchParentSize()) {
                        // A broken pets file leaves the tile names only.
                        if (pets == null) return@Canvas
                        val fy = 53.0
                        drawRect(outline, Offset(10.dp.toPx(), fy.toFloat().dp.toPx()),
                            androidx.compose.ui.geometry.Size(size.width - 20.dp.toPx(), 1.dp.toPx()))
                        val cx = size.width / density / 2.0
                        if (value == "off") {
                            val t = if (selected && !reducedMotion) tileTime else null
                            val y = fy - 6
                            val start = if (t != null) Offset(10.dp.toPx(), y.toFloat().dp.toPx())
                                else Offset((cx - 24).toFloat().dp.toPx(), (y + 3).toFloat().dp.toPx())
                            val end = if (t != null) Offset(size.width - 10.dp.toPx(), y.toFloat().dp.toPx())
                                else Offset((cx + 12).toFloat().dp.toPx(), (y - 3).toFloat().dp.toPx())
                            drawMessage(MessageFlight(Message(), 0, 700.0, false, false), ((t ?: 390.0) * 1_000_000).toLong(),
                                MessageEndpoint(start, false), MessageEndpoint(end, false), messageColor, false)
                        } else pets?.let { sprites ->
                            sprites.pets[value]?.let { sprite ->
                                val hop = if (selected && !reducedMotion) tileTime?.let(::petTilePose) else null
                                drawPet(sprites, sprite, 2.0, messageColor, PetPose(hop?.first ?: "stand", cx, fy + (hop?.second ?: 0.0), 1, null))
                            }
                        }
                    }
                    Text(name, color = hexColor(palette.text), fontSize = 13.sp, lineHeight = 16.sp,
                        textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().offset(y = 65.dp)
                            .clearAndSetSemantics { })
                    if (selected) Box(Modifier.align(Alignment.TopEnd).padding(6.dp).size(18.dp).background(accent, CircleShape),
                        contentAlignment = Alignment.Center) {
                        Icon(Icons.Default.Check, contentDescription = null, tint = hexColor(palette.background), modifier = Modifier.size(12.dp))
                    }
                }
            }
        }
    }
    Text("A pixel pet carries each message from card to card.", style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant)
    PetStage(pet, pets, choice, reducedMotion)
}

@Composable
private fun PetStage(pet: String, pets: Pets?, choice: Int, reducedMotion: Boolean) {
    val palette = LocalPalette.current
    val messageColor = MaterialTheme.colorScheme.primary
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val density = LocalDensity.current.density
    val ends = remember { mutableStateMapOf<Int, PetPoint>() }
    var origin by remember { mutableStateOf(Offset.Zero) }
    var time by remember { mutableDoubleStateOf(-1.0) }
    var plan by remember { mutableStateOf<PetPlan?>(null) }
    var duration by remember { mutableDoubleStateOf(700.0) }
    var lit by remember { mutableStateOf(setOf<Int>()) }
    val sprite = pets?.pets?.get(pet)
    LaunchedEffect(pet, pets, choice, reducedMotion, lifecycle) {
        time = -1.0
        plan = null
        lit = emptySet()
        var played = false
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            try {
                if (reducedMotion) {
                    if (choice == 0 || played) return@repeatOnLifecycle
                    played = true
                    lit = setOf(0, 1)
                    delay(2000)
                    lit = emptySet()
                    return@repeatOnLifecycle
                }
                delay(400)
                while (isActive) {
                    val sender = ends[0]
                    val receiver = ends[1]
                    if (sender == null || receiver == null) { delay(4600); continue }
                    val runPlan = sprite?.let { petPlan(it, 2.0, sender, receiver) }
                    plan = runPlan
                    duration = if (runPlan == null) messageDuration(kotlin.math.hypot(receiver.x - sender.x, receiver.y - sender.y)) else runPlan.end
                    val end = runPlan?.end ?: (duration + 420)
                    val start = withFrameNanos { it }
                    do {
                        val t = withFrameNanos { (it - start) / 1_000_000.0 }
                        time = t
                        lit = if (runPlan != null) buildSet {
                            if (t < 400) add(0)
                            if (t >= runPlan.ta && t < runPlan.ta + 360) add(1)
                        } else if (t < 160) setOf(0) else emptySet()
                    } while (t < end)
                    time = -1.0
                    lit = emptySet()
                    // The next run is 4.6 s from this run's start, not from its end.
                    delay((4600 - (System.nanoTime() - start) / 1_000_000).coerceAtLeast(0))
                }
            } finally {
                time = -1.0
                lit = emptySet()
            }
        }
    }
    val shape = RoundedCornerShape(8.dp)
    val name = pet.replaceFirstChar { it.uppercase() }
    val description = if (pet == "off") "The light carries a message between two sample cards"
        else "$name carries a message between two sample cards"
    Box(Modifier.fillMaxWidth().height(116.dp).clip(shape).background(hexColor(palette.background))
        .border(1.dp, hexColor(mixColor(palette.background, palette.text, .15)), shape)
        .onGloballyPositioned { origin = it.positionInRoot() }
        .clearAndSetSemantics { contentDescription = description }) {
        Row(Modifier.fillMaxWidth().align(Alignment.Center).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SAMPLE_CARDS.forEachIndexed { index, row ->
                val tones = cardTones(palette, row, comfortable = true, drawerView = false, pressed = false)
                var markCenter by remember { mutableStateOf(Offset.Zero) }
                var floor by remember { mutableFloatStateOf(0f) }
                fun updateEnd() {
                    ends[index] = PetPoint(((markCenter.x - origin.x) / density).toDouble(),
                        ((markCenter.y - origin.y) / density).toDouble(), ((floor - origin.y) / density).toDouble())
                }
                Column(Modifier.weight(1f).height(68.dp).onGloballyPositioned {
                    floor = it.positionInRoot().y + it.size.height
                    updateEnd()
                }.drawBehind {
                    val alpha = plan?.takeIf { time >= 0 }?.let { petTints(it, time)[index] } ?: 0.0
                    if (alpha > 0) drawRoundRect(messageColor.copy(alpha = (.15 * alpha).toFloat()), cornerRadius = CornerRadius(3.dp.toPx()))
                }.padding(horizontal = 8.dp, vertical = COMFORTABLE_PADDING.dp), verticalArrangement = Arrangement.spacedBy(COMFORTABLE_SPACING.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
                        ProviderMark(row, false, index in lit, palette, Modifier.onGloballyPositioned {
                            markCenter = it.positionInRoot() + Offset(it.size.width / 2f, it.size.height / 2f)
                            updateEnd()
                        })
                        Text(row.projectName, fontSize = 11.sp, lineHeight = CAPTION_LINE_HEIGHT.sp, color = hexColor(tones.caption),
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Text(row.title, fontSize = 13.sp, lineHeight = TITLE_LINE_HEIGHT.sp, color = hexColor(tones.title), maxLines = 2,
                        minLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 21.dp))
                    Row(Modifier.padding(start = 21.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("Idle", fontSize = 11.sp, lineHeight = CAPTION_LINE_HEIGHT.sp, color = hexColor(tones.state))
                        Text("2m", fontSize = 11.sp, lineHeight = CAPTION_LINE_HEIGHT.sp, color = hexColor(tones.caption),
                            textAlign = TextAlign.End, modifier = Modifier.weight(1f))
                    }
                }
            }
        }
        Canvas(Modifier.matchParentSize()) {
            val t = time
            if (reducedMotion || t < 0) return@Canvas
            val sender = ends[0] ?: return@Canvas
            val receiver = ends[1] ?: return@Canvas
            val runPlan = plan
            if (pets != null && sprite != null && runPlan != null) drawPetFlight(pets, sprite, 2.0, runPlan, t, sender, receiver, messageColor)
            else drawMessage(MessageFlight(Message(), 0, duration, false, false), (t * 1_000_000).toLong(),
                MessageEndpoint(Offset((sender.x * density).toFloat(), (sender.y * density).toFloat()), false),
                MessageEndpoint(Offset((receiver.x * density).toFloat(), (receiver.y * density).toFloat()), false), messageColor, false)
        }
    }
}
