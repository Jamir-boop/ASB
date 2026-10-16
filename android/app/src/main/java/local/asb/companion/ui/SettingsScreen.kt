package local.asb.companion.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import local.asb.companion.data.Endpoint
import local.asb.companion.data.Hello
import local.asb.companion.data.Store
import local.asb.companion.data.endpointLabel
import local.asb.companion.net.AsbApi
import local.asb.companion.net.AsbError
import local.asb.companion.net.DashboardResult
import local.asb.companion.notify.LiveService

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    store: Store,
    api: AsbApi,
    notificationsAllowed: Boolean,
    onBack: () -> Unit,
    onUnpair: () -> Unit,
    onRequestNotificationPermission: () -> Unit,
    onCheckNow: () -> Unit,
    onPersistentUnreadChanged: () -> Unit = {},
    onViewChanged: (String) -> Unit = {},
    onTextScaleChanged: (Float) -> Unit = {},
    useCameraArea: Boolean = true,
    onUseCameraAreaChanged: (Boolean) -> Unit = {},
    liveNotification: Boolean,
    onLiveNotificationChanged: (Boolean) -> Unit,
) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val requests = remember(api) { Mutex() }
    val currentOnPersistentUnreadChanged by rememberUpdatedState(onPersistentUnreadChanged)
    var hello by remember(api) { mutableStateOf<Hello?>(null) }
    var connectionError by remember(api) { mutableStateOf<String?>(null) }
    var persistentUnread by remember(api) { mutableStateOf<Boolean?>(null) }
    var settingsError by remember(api) { mutableStateOf<String?>(null) }
    var refreshing by remember(api) { mutableStateOf(true) }
    var savingUnread by remember(api) { mutableStateOf(false) }
    var revoked by remember(api) { mutableStateOf(store.revoked) }
    var attempt by remember { mutableIntStateOf(0) }
    var confirmUnpair by rememberSaveable { mutableStateOf(false) }
    var license by rememberSaveable { mutableStateOf<String?>(null) }
    var notifyDone by remember(store) { mutableStateOf(store.notifyDone) }
    var notifyFailed by remember(store) { mutableStateOf(store.notifyFailed) }
    var notifyInput by remember(store) { mutableStateOf(store.notifyInput) }
    var view by remember(store) { mutableStateOf(store.view) }
    var textScale by remember(store) { mutableFloatStateOf(store.textScale) }
    val palette = LocalPalette.current
    val paletteFromPc = remember(store, palette) { store.palette != null }
    val version = remember(context) {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        "${info.versionName.orEmpty()} (${info.longVersionCode})"
    }
    val feedback: (String) -> Unit = { message -> scope.launch { snackbar.showSnackbar(message) } }
    val openSettings: (Intent) -> Unit = { intent ->
        try { context.startActivity(intent) }
        catch (_: ActivityNotFoundException) { feedback("Could not open app settings. Open Android Settings > Apps > ASB.") }
        catch (_: SecurityException) { feedback("Could not open app settings. Open Android Settings > Apps > ASB.") }
    }

    BackHandler(onBack = onBack)
    LaunchedEffect(api, lifecycle, attempt) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            requests.withLock {
                refreshing = true
                hello = null
                persistentUnread = null
                connectionError = null
                settingsError = null
                revoked = store.revoked
                try {
                    if (revoked) throw AsbError.NotPaired
                    val reply = api.hello()
                    currentCoroutineContext().ensureActive()
                    if (reply.deviceId != store.deviceId) throw AsbError.Server("ASB sent an invalid response. Try again.")
                    hello = reply
                    try {
                        val result = api.dashboard(null, force = true)
                        currentCoroutineContext().ensureActive()
                        persistentUnread = (result as? DashboardResult.Fetched)?.dashboard?.persistentUnread
                            ?: throw AsbError.Server("ASB did not return the current setting. Check connection and try again.")
                    } catch (cause: AsbError) {
                        currentCoroutineContext().ensureActive()
                        settingsError = cause.message
                        if (cause === AsbError.NotPaired) throw cause
                    }
                } catch (cause: AsbError) {
                    currentCoroutineContext().ensureActive()
                    connectionError = cause.message
                    if (cause === AsbError.NotPaired) { revoked = true; hello = null }
                } finally { refreshing = false }
            }
            awaitCancellation()
        }
    }

    Scaffold(
        contentWindowInsets = SafeContentInsets,
        topBar = {
            TopAppBar(windowInsets = SafeTopBarInsets, title = { Text("Settings") }, navigationIcon = {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
            })
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding), contentAlignment = Alignment.TopCenter) {
            Column(
                modifier = Modifier.widthIn(max = 600.dp).fillMaxWidth()
                    .verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SettingsHeading("Connection")
                    Text(hello?.serverName?.takeIf { it.isNotBlank() } ?: store.serverName.ifBlank { "Paired PC" },
                        style = MaterialTheme.typography.titleMedium)
                    EndpointList(store.endpoints, store.currentEndpoint, store.port)
                    Text(
                        when {
                            refreshing -> "Checking ASB…"
                            hello != null -> "Connected to ASB ${hello!!.asbVersion}"
                            else -> "Connection needs attention"
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    connectionError?.let { SettingsError(it) }
                    Text("Certificate fingerprint", style = MaterialTheme.typography.labelLarge)
                    SelectionContainer {
                        Text(store.fingerprint.chunked(4).joinToString(" "),
                            style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace)
                    }
                    OutlinedButton(onClick = { attempt++ }, enabled = !refreshing && !savingUnread && !revoked,
                        modifier = Modifier.fillMaxWidth()) { Text("Check connection") }
                    TextButton(onClick = { confirmUnpair = true }, enabled = !savingUnread,
                        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                        modifier = Modifier.fillMaxWidth()) {
                        Text("Unpair this phone")
                    }
                }
                HorizontalDivider()
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SettingsHeading("ASB")
                    val unread = persistentUnread
                    if (unread != null) {
                        SettingsSwitch("Persistent unread", unread, !refreshing && !savingUnread && !revoked) { checked ->
                            savingUnread = true
                            settingsError = null
                            scope.launch {
                                requests.withLock {
                                    try {
                                        api.setPersistentUnread(checked)
                                        currentCoroutineContext().ensureActive()
                                        currentOnPersistentUnreadChanged()
                                        val result = api.dashboard(null, force = true)
                                        currentCoroutineContext().ensureActive()
                                        persistentUnread = (result as? DashboardResult.Fetched)?.dashboard?.persistentUnread
                                            ?: throw AsbError.Server("ASB did not return the current setting. Check connection and try again.")
                                    } catch (cause: AsbError) {
                                        currentCoroutineContext().ensureActive()
                                        persistentUnread = null
                                        settingsError = cause.message
                                        if (cause === AsbError.NotPaired) {
                                            revoked = true
                                            hello = null
                                            connectionError = cause.message
                                        }
                                    } finally { savingUnread = false }
                                }
                            }
                        }
                    } else {
                        Text("Persistent unread", style = MaterialTheme.typography.bodyLarge)
                        Text(if (refreshing) "Loading PC setting…" else "Check connection to load this setting.",
                            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text("Keep unread marks until you select Read. This is the same setting as on the PC.",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (savingUnread) Text("Saving…", style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                    settingsError?.let { SettingsError(it) }
                }
                HorizontalDivider()
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SettingsHeading("Appearance")
                    Text(
                        "Theme: follows the PC (" + when {
                            !paletteFromPc -> "default colors until the PC sends its colors"
                            palette.custom -> "Custom colors"
                            else -> "GNOME colors"
                        } + ")",
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    Text("View", style = MaterialTheme.typography.labelLarge)
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        listOf("compact" to "Compact", "comfortable" to "Comfortable").forEachIndexed { index, (value, label) ->
                            SegmentedButton(
                                selected = view == value,
                                onClick = { view = value; store.view = value; onViewChanged(value) },
                                shape = SegmentedButtonDefaults.itemShape(index, 2),
                                modifier = Modifier.heightIn(min = 48.dp),
                            ) { Text(label) }
                        }
                    }
                    Text("Text size", style = MaterialTheme.typography.labelLarge)
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        TEXT_SCALES.forEachIndexed { index, (value, label) ->
                            SegmentedButton(
                                selected = textScale == value,
                                onClick = { textScale = value; onTextScaleChanged(value) },
                                shape = SegmentedButtonDefaults.itemShape(index, TEXT_SCALES.size),
                                modifier = Modifier.heightIn(min = 48.dp),
                            ) { Text(label) }
                        }
                    }
                    SettingsSwitch("Use the camera area", useCameraArea, onChecked = onUseCameraAreaChanged)
                    Text("Draw the app under the camera hole. Turn off to keep that band clear.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                HorizontalDivider()
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SettingsHeading("Notifications")
                    SettingsSwitch("Done", notifyDone) { notifyDone = it; store.notifyDone = it }
                    SettingsSwitch("Failed", notifyFailed) { notifyFailed = it; store.notifyFailed = it }
                    SettingsSwitch("Needs input", notifyInput) { notifyInput = it; store.notifyInput = it }
                    SettingsSwitch("Live notification", liveNotification) {
                        // The setter runs first, because startIfEnabled reads the saved switch.
                        onLiveNotificationChanged(it)
                        if (it) LiveService.startIfEnabled(context) else LiveService.stop(context)
                    }
                    Text("Shows the number of sessions, Working, and Pending. While the phone is awake, it checks every 5 seconds while a session is working, and every 30 seconds when not. Android can delay checks while the screen is off.",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (!notificationsAllowed) {
                        Text("Notifications are off for ASB.", style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Button(onClick = onRequestNotificationPermission, modifier = Modifier.fillMaxWidth()) {
                            Text("Allow notifications")
                        }
                    }
                    OutlinedButton(onClick = {
                        openSettings(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
                    }, modifier = Modifier.fillMaxWidth()) { Text("Notification sound and style") }
                }
                HorizontalDivider()
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SettingsHeading("Background")
                    Text("Background checks run about every 15 minutes. Android and HyperOS can delay them.",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    OutlinedButton(onClick = { onCheckNow(); feedback("Background check requested.") },
                        enabled = !revoked, modifier = Modifier.fillMaxWidth()) { Text("Check now") }
                    OutlinedCard(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text("HyperOS can stop background checks. In app info, set Battery saver to No restrictions. Turn on Autostart in HyperOS settings.",
                                style = MaterialTheme.typography.bodyMedium)
                            Text("The names and location of these settings can differ by phone.",
                                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            TextButton(onClick = {
                                openSettings(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                    Uri.parse("package:${context.packageName}")))
                            }, modifier = Modifier.fillMaxWidth()) { Text("Open app info") }
                        }
                    }
                }
                HorizontalDivider()
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SettingsHeading("About")
                    Text("App version $version", style = MaterialTheme.typography.bodyMedium)
                    SettingsLicenses.keys.forEach { title ->
                        TextButton(onClick = { license = title }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                            Text(title, modifier = Modifier.fillMaxWidth(), style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                }
            }
        }
    }
    val density = LocalDensity.current
    if (confirmUnpair) AlertDialog(
        onDismissRequest = { confirmUnpair = false },
        title = withDensity(density) { Text("Unpair this phone?") },
        text = withDensity(density) { Text("This removes the saved pairing from this phone. Also remove this phone in ASB Preferences > Phone on the PC.") },
        confirmButton = withDensity(density) { TextButton(onClick = { confirmUnpair = false; onUnpair() }) { Text("Unpair") } },
        dismissButton = withDensity(density) { TextButton(onClick = { confirmUnpair = false }) { Text("Cancel") } },
    )
    license?.let { title -> LicenseDialog(title, SettingsLicenses.getValue(title)) { license = null } }
}

/** The addresses of the paired PC with their kinds; the one that answered last is marked Current. */
@Composable
fun EndpointList(endpoints: List<Endpoint>, current: Endpoint?, port: Int) {
    SelectionContainer {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            for (endpoint in endpoints) Text(
                "${endpointLabel(endpoint.kind)}: ${endpoint.host}:$port" + if (endpoint == current) " · Current" else "",
                style = MaterialTheme.typography.bodyLarge,
            )
        }
    }
}

@Composable
private fun SettingsHeading(title: String) {
    Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
}

@Composable
private fun SettingsSwitch(label: String, checked: Boolean, enabled: Boolean = true, onChecked: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)
            .toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onChecked),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}

@Composable
private fun SettingsError(message: String) {
    Text(message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
}

@Composable
private fun LicenseDialog(title: String, paths: List<String>, onDismiss: () -> Unit) {
    val assets = LocalContext.current.assets
    val text by produceState<String?>(initialValue = null, title) {
        value = try {
            withContext(Dispatchers.IO) { paths.joinToString("\n\n") { path -> assets.open(path).bufferedReader().use { it.readText() } } }
        } catch (_: IOException) { "Could not load this license. Close this dialog and try again." }
    }
    val density = LocalDensity.current
    AlertDialog(
        onDismissRequest = onDismiss,
        title = withDensity(density) { Text(title) },
        text = withDensity(density) {
            SelectionContainer {
                Text(text ?: "Loading license…", style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()))
            }
        },
        confirmButton = withDensity(density) { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

private val TEXT_SCALES = listOf(0.85f to "Small", 1f to "Default", 1.15f to "Large", 1.3f to "Larger")

private val SettingsLicenses = linkedMapOf(
    "ASB (MIT)" to listOf("licenses/asb-LICENSE.txt"),
    "Sounds: opencode (MIT)" to listOf("licenses/opencode-LICENSE.txt"),
    "Unicode data (Unicode-3.0)" to listOf("licenses/UNICODE.txt"),
    "Material Icons (Apache-2.0)" to listOf("licenses/material-icons-LICENSE.txt", "licenses/material-icons-NOTICE.txt"),
)
