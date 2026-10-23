package local.asb.companion.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import local.asb.companion.data.Palette
import local.asb.companion.data.contrast
import local.asb.companion.data.mixColor

val LocalPalette = staticCompositionLocalOf { Palette() }

// Control outlines need 3:1 contrast (WCAG non-text); a custom divider can be almost the background color.
fun controlOutline(palette: Palette): String =
    if (contrast(palette.divider, palette.background) >= 3.0) palette.divider else palette.muted

// Settings > Appearance > Use the camera area: true draws under the camera hole, false keeps the cutout band clear.
val LocalUseCameraArea = staticCompositionLocalOf { true }

// Fullscreen hides the system bars; without the camera area the insets keep content clear of the cutout.
val SafeContentInsets: WindowInsets
    @Composable get() = if (LocalUseCameraArea.current) WindowInsets.systemBars.union(WindowInsets.ime) else WindowInsets.safeDrawing
val SafeTopBarInsets: WindowInsets
    @Composable get() = SafeContentInsets.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)

fun hexColor(value: String): Color = Color(0xff000000L or value.substring(1).toLong(16))

// The desktop is dark only, so the app is too: one dark scheme from the PC palette, no dynamic color.
internal fun asbColorScheme(palette: Palette): ColorScheme {
    val background = hexColor(palette.background)
    val text = hexColor(palette.text)
    val accent = hexColor(palette.accent)
    val divider = hexColor(palette.divider)
    val highlight = hexColor(palette.highlight)
    return darkColorScheme(
        primary = accent,
        onPrimary = background,
        background = background,
        onBackground = text,
        surface = background,
        onSurface = text,
        onSurfaceVariant = hexColor(palette.muted),
        outline = divider,
        outlineVariant = divider,
        surfaceVariant = highlight,
        surfaceContainerLowest = highlight,
        surfaceContainerLow = highlight,
        surfaceContainer = highlight,
        surfaceContainerHigh = highlight,
        surfaceContainerHighest = highlight,
        secondaryContainer = accent,
        onSecondaryContainer = background,
        // The snackbar uses the inverse roles; without them it is near white on a dark app.
        inverseSurface = hexColor(mixColor(palette.background, palette.text, .10)),
        inverseOnSurface = text,
        inversePrimary = accent,
    )
}

@Composable
fun AsbTheme(palette: Palette, content: @Composable () -> Unit) {
    val scheme = remember(palette) { asbColorScheme(palette) }
    MaterialTheme(colorScheme = scheme) {
        CompositionLocalProvider(LocalPalette provides palette, content = content)
    }
}

// The message strip is a raised dark strip with a thin edge, so it reads as part of the dark app.
@Composable
fun AsbSnackbarHost(state: SnackbarHostState) {
    val palette = LocalPalette.current
    val shape = RoundedCornerShape(12.dp)
    SnackbarHost(state) { data ->
        Snackbar(data, shape = shape, modifier = Modifier.border(1.dp, hexColor(mixColor(palette.background, palette.text, .20)), shape))
    }
}
