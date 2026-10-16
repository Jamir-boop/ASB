package local.asb.companion

import local.asb.companion.ui.SafeTopBarInsets
import local.asb.companion.ui.SafeContentInsets
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.cancel
import kotlinx.serialization.encodeToString
import local.asb.companion.data.AsbJson
import local.asb.companion.data.Hello
import local.asb.companion.net.AsbError
import local.asb.companion.net.AsbApi
import local.asb.companion.notify.CheckWorker
import local.asb.companion.notify.Notifier
import local.asb.companion.ui.AsbTheme
import local.asb.companion.ui.EndpointList
import local.asb.companion.ui.PairScreen
import local.asb.companion.ui.PairingViewModel
import local.asb.companion.ui.SessionsScreen
import local.asb.companion.ui.SessionsViewModel
import local.asb.companion.ui.SettingsScreen

class MainActivity : ComponentActivity() {
    private var notificationsAllowed by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Dark only: transparent bars with light icons over the palette background.
        val bars = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
        enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
        // Fullscreen: the system bars hide; a swipe from an edge shows them for a moment.
        WindowCompat.getInsetsController(window, window.decorView).run {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
        val app = application as AsbApp
        app.notifier.opened(intent)
        notificationsAllowed = Notifier.notificationsAllowed(this)
        setContent {
            AsbTheme(app.palette) {
                val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
                    notificationsAllowed = Notifier.notificationsAllowed(this)
                }
                val requestNotifications = {
                    val asked = app.store.notificationPermissionAsked
                    app.store.notificationPermissionAsked = true
                    if (Build.VERSION.SDK_INT >= 33 &&
                        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
                        (!asked || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))) {
                        permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    } else {
                        startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
                    }
                }
                val pairingModel = viewModel<PairingViewModel>(factory = remember(app) {
                    viewModelFactory { initializer { PairingViewModel(app.store::save) } }
                })
                var paired by remember { mutableStateOf(app.store.paired) }
                if (paired) PairedApp(app, notificationsAllowed, requestNotifications) {
                    app.notifier.clear()
                    pairingModel.reset()
                    app.store.clear()
                    app.usePalette(null)
                    paired = false
                }
                else PairScreen(this, pairingModel) { paired = true }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        (application as AsbApp).resumed = true
        notificationsAllowed = Notifier.notificationsAllowed(this)
    }

    override fun onPause() {
        (application as AsbApp).resumed = false
        super.onPause()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        (application as AsbApp).notifier.opened(intent)
    }
}

private enum class Screen { VERIFY, SESSIONS, CONNECTION }

@Composable
private fun PairedApp(
    app: AsbApp,
    notificationsAllowed: Boolean,
    onRequestNotificationPermission: () -> Unit,
    onUnpair: () -> Unit,
) {
    val store = app.store
    val token = store.token
    val deviceId = store.deviceId
    val api = remember(deviceId, token) { app.api() }
    var screen by rememberSaveable(deviceId) { mutableStateOf(Screen.VERIFY) }
    var serverName by rememberSaveable(deviceId) { mutableStateOf(store.serverName) }
    if (screen == Screen.VERIFY) {
        ConnectionScreen(app, api, onUnpair = onUnpair, onVerified = {
            serverName = it.serverName
            screen = Screen.SESSIONS
        })
    } else {
        LaunchedEffect(deviceId) {
            if (Build.VERSION.SDK_INT >= 33 && !store.notificationPermissionAsked) {
                if (notificationsAllowed) store.notificationPermissionAsked = true
                else onRequestNotificationPermission()
            }
        }
        val sessionsModel = viewModel<SessionsViewModel>(key = "sessions:$deviceId", factory = remember(api, serverName) {
            viewModelFactory {
                initializer {
                    SessionsViewModel(api, serverName, store.revoked,
                        saveBaseline = { baseline ->
                            if (app.resumed) store.saveBaselineIfPaired(token, AsbJson.encodeToString(baseline))
                        },
                        notificationMutex = app.notificationMutex,
                        loadBaseline = { store.loadBaselineIfPaired(token) },
                        initialView = store.view,
                        savePalette = app::usePalette,
                    )
                }
            }
        })
        val unpair = {
            sessionsModel.viewModelScope.cancel()
            onUnpair()
        }
        if (screen == Screen.CONNECTION) {
            SettingsScreen(store, api, notificationsAllowed,
                onBack = { screen = Screen.SESSIONS },
                onUnpair = unpair,
                onRequestNotificationPermission = onRequestNotificationPermission,
                onCheckNow = { CheckWorker.checkNow(app) },
                onPersistentUnreadChanged = sessionsModel::refresh,
                onViewChanged = sessionsModel::setView,
            )
        } else {
            SessionsScreen(sessionsModel, serverName,
                onSettings = { screen = Screen.CONNECTION }, onPairAgain = unpair)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConnectionScreen(
    app: AsbApp,
    api: AsbApi,
    onUnpair: () -> Unit,
    onBack: (() -> Unit)? = null,
    onVerified: (Hello) -> Unit = {},
) {
    var hello by remember { mutableStateOf<Hello?>(null) }
    var error by remember { mutableStateOf<AsbError?>(null) }
    var busy by remember { mutableStateOf(!app.store.revoked) }
    var attempt by remember { mutableIntStateOf(0) }
    var confirmUnpair by remember { mutableStateOf(false) }
    val currentOnVerified by rememberUpdatedState(onVerified)
    if (onBack != null) BackHandler(onBack = onBack)
    LaunchedEffect(api, attempt) {
        if (app.store.revoked) error = AsbError.NotPaired
        else {
            busy = true
            error = null
            hello = null
            try {
                val reply = api.hello()
                if (reply.deviceId != app.store.deviceId) throw AsbError.Server("ASB sent an invalid response. Try again.")
                hello = reply
                currentOnVerified(reply)
            }
            catch (cause: AsbError) { error = cause }
            finally { busy = false }
        }
    }
    Scaffold(contentWindowInsets = SafeContentInsets, topBar = {
        TopAppBar(title = { Text(if (onBack == null) "ASB" else "Connection") },
            navigationIcon = { onBack?.let { TextButton(onClick = it) { Text("Back") } } }, windowInsets = SafeTopBarInsets)
    }) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding), contentAlignment = Alignment.TopCenter) {
            Column(
                modifier = Modifier.widthIn(max = 600.dp).fillMaxWidth()
                    .verticalScroll(rememberScrollState()).padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text(
                    text = when {
                        busy -> "Checking ASB…"
                        hello != null -> "Connected to ${hello!!.serverName}"
                        else -> "Connection needs attention"
                    },
                    style = MaterialTheme.typography.headlineSmall,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
                EndpointList(app.store.endpoints, app.store.currentEndpoint, app.store.port)
                hello?.let { Text("ASB ${it.asbVersion}") }
                error?.let { Text(it.message.orEmpty(), color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
                if (error === AsbError.NotPaired) {
                    Button(onClick = onUnpair, modifier = Modifier.fillMaxWidth()) { Text("Pair again") }
                } else {
                    Button(onClick = { attempt++ }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                        Text("Check connection")
                    }
                    OutlinedButton(onClick = { confirmUnpair = true }, modifier = Modifier.fillMaxWidth()) {
                        Text("Unpair this phone")
                    }
                }
            }
        }
    }
    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text("Unpair this phone?") },
            text = { Text("Also remove this phone in ASB Preferences > Phone on the PC.") },
            confirmButton = { TextButton(onClick = onUnpair) { Text("Unpair") } },
            dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text("Cancel") } },
        )
    }
}
