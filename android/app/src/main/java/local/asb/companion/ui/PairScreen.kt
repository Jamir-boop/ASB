package local.asb.companion.ui

import android.app.Activity
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlinx.coroutines.Job
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import local.asb.companion.data.PairingInfo
import local.asb.companion.data.PairReply
import local.asb.companion.data.parsePairingUri
import local.asb.companion.net.AsbApi
import local.asb.companion.net.AsbError

class PairingViewModel(
    private val savePairing: (PairingInfo, PairReply) -> Unit,
    private val pairRequest: suspend (PairingInfo, String) -> PairReply = { info, name -> AsbApi.pair(info, name) },
) : ViewModel() {
    var input by mutableStateOf("")
        private set
    var candidate by mutableStateOf<PairingInfo?>(null)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var busy by mutableStateOf(false)
        private set
    var scanning by mutableStateOf(false)
        private set
    var paired by mutableStateOf(false)
        private set
    private var pairingJob: Job? = null
    private var scanId = 0

    fun changeInput(value: String) { input = value; error = null }

    fun review(value: String) {
        if (busy || paired) return
        scanId++
        scanning = false
        candidate = parsePairingUri(value)
        error = if (candidate == null) "This is not an ASB pairing code." else null
    }

    fun startScan(): Int {
        scanning = true
        error = null
        return ++scanId
    }

    fun scanResult(id: Int, value: String) {
        if (id == scanId) review(value)
    }

    fun stopScan(id: Int, failed: Boolean = false) {
        if (id != scanId) return
        scanning = false
        if (failed) error = "Could not open the scanner. Paste the pairing link below."
    }

    fun pair(deviceName: String) {
        val info = candidate ?: return
        if (busy || paired) return
        busy = true
        error = null
        val job = viewModelScope.launch(start = CoroutineStart.LAZY) {
            try {
                val reply = pairRequest(info, deviceName)
                coroutineContext.ensureActive()
                savePairing(info, reply)
                paired = true
            } catch (cause: AsbError) {
                coroutineContext.ensureActive()
                error = cause.message
            } finally {
                if (pairingJob == coroutineContext[Job]) {
                    pairingJob = null
                    busy = false
                }
            }
        }
        pairingJob = job
        job.start()
    }

    fun back() {
        pairingJob?.cancel()
        pairingJob = null
        scanId++
        scanning = false
        busy = false
        candidate = null
        error = null
    }

    fun reset() {
        back()
        input = ""
        paired = false
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairScreen(activity: Activity, model: PairingViewModel, onPaired: () -> Unit) {
    LaunchedEffect(model.paired) { if (model.paired) onPaired() }
    BackHandler(enabled = model.candidate != null) { model.back() }
    Scaffold(contentWindowInsets = SafeContentInsets, topBar = {
        TopAppBar(
            windowInsets = SafeTopBarInsets,
            title = { Text("Pair with ASB") },
            navigationIcon = { if (model.candidate != null) TextButton(onClick = model::back) { Text("Back") } },
        )
    }) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding), contentAlignment = Alignment.TopCenter) {
            Column(
                modifier = Modifier.widthIn(max = 600.dp).fillMaxWidth().imePadding()
                    .verticalScroll(rememberScrollState()).padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                val info = model.candidate
                if (info == null) {
                    Text("On the PC open ASB Preferences > Phone, turn on phone access, and select Pair a phone.")
                    OutlinedButton(
                        enabled = !model.scanning,
                        modifier = Modifier.fillMaxWidth(),
                        onClick = {
                            val scanId = model.startScan()
                            try {
                                val options = GmsBarcodeScannerOptions.Builder()
                                    .setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
                                GmsBarcodeScanning.getClient(activity, options).startScan()
                                    .addOnSuccessListener { result -> model.scanResult(scanId, result.rawValue.orEmpty()) }
                                    .addOnCanceledListener { model.stopScan(scanId) }
                                    .addOnFailureListener { model.stopScan(scanId, failed = true) }
                            } catch (_: Exception) {
                                model.stopScan(scanId, failed = true)
                            }
                        },
                    ) { Text(if (model.scanning) "Opening scanner…" else "Scan QR code") }
                    OutlinedTextField(
                        value = model.input,
                        onValueChange = model::changeInput,
                        label = { Text("Or paste the pairing link") },
                        modifier = Modifier.fillMaxWidth(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                        maxLines = 4,
                    )
                    model.error?.let { PairingError(it) }
                    Button(onClick = { model.review(model.input) }, enabled = model.input.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
                        Text("Pair")
                    }
                } else {
                    Text("Check the PC", style = MaterialTheme.typography.headlineSmall)
                    Text("PC: ${info.serverName.ifEmpty { "ASB" }}")
                    EndpointList(info.addresses, null, info.port)
                    Text("Certificate", style = MaterialTheme.typography.titleMedium)
                    Text(info.fingerprint.chunked(4).joinToString(" "), fontFamily = FontFamily.Monospace)
                    Text("Compare this fingerprint with ASB Preferences > Phone before you pair.")
                    model.error?.let { PairingError(it) }
                    Button(
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !model.busy,
                        onClick = {
                            val name = try {
                                Settings.Global.getString(activity.contentResolver, Settings.Global.DEVICE_NAME)
                            } catch (_: SecurityException) { null }
                            model.pair(name?.takeIf { it.isNotBlank() } ?: "${Build.MANUFACTURER} ${Build.MODEL}")
                        },
                    ) { Text(if (model.busy) "Pairing…" else "Pair with this PC") }
                }
            }
        }
    }
}

@Composable
private fun PairingError(message: String) {
    Text(message, color = MaterialTheme.colorScheme.error,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
}
