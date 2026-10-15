package local.asb.companion

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import local.asb.companion.data.Hello
import local.asb.companion.net.AsbError
import local.asb.companion.ui.AsbTheme
import local.asb.companion.ui.PairScreen
import local.asb.companion.ui.PairingViewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as AsbApp
        setContent {
            AsbTheme {
                val pairingModel = viewModel<PairingViewModel>(factory = remember(app) {
                    viewModelFactory { initializer { PairingViewModel(app.store::save) } }
                })
                var paired by remember { mutableStateOf(app.store.paired) }
                if (paired) ConnectionScreen(app) {
                    pairingModel.reset()
                    app.store.clear()
                    paired = false
                }
                else PairScreen(this, pairingModel) { paired = true }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConnectionScreen(app: AsbApp, onUnpair: () -> Unit) {
    val api = remember { app.api() }
    var hello by remember { mutableStateOf<Hello?>(null) }
    var error by remember { mutableStateOf<AsbError?>(null) }
    var busy by remember { mutableStateOf(!app.store.revoked) }
    var attempt by remember { mutableIntStateOf(0) }
    var confirmUnpair by remember { mutableStateOf(false) }
    LaunchedEffect(attempt) {
        if (app.store.revoked) error = AsbError.NotPaired
        else {
            busy = true
            error = null
            hello = null
            try { hello = api.hello() }
            catch (cause: AsbError) { error = cause }
            finally { busy = false }
        }
    }
    Scaffold(topBar = { TopAppBar(title = { Text("ASB") }) }) { padding ->
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
                Text("${app.store.host}:${app.store.port}")
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
