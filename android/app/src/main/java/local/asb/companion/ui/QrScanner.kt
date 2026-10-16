package local.asb.companion.ui

import android.util.Size
import androidx.activity.compose.BackHandler
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Observer
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@Composable
fun QrScanner(onResult: (String) -> Unit, onFailed: () -> Unit, onCancel: () -> Unit) {
    BackHandler(onBack = onCancel)
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val previewView = remember(context) { PreviewView(context) }
    val currentOnResult by rememberUpdatedState(onResult)
    val currentOnFailed by rememberUpdatedState(onFailed)
    DisposableEffect(lifecycleOwner, previewView) {
        val analyzerExecutor = Executors.newSingleThreadExecutor()
        val mainExecutor = ContextCompat.getMainExecutor(context)
        val found = AtomicBoolean(false)
        var disposed = false
        var provider: ProcessCameraProvider? = null
        var camera: Camera? = null
        // CameraX opens the camera after the bind, so open errors come only through the camera state.
        val stateObserver = Observer<CameraState> { state ->
            if (state.error?.type == CameraState.ErrorType.CRITICAL && !disposed && found.compareAndSet(false, true)) {
                currentOnFailed()
            }
        }
        val preview = Preview.Builder().build().apply { setSurfaceProvider(previewView.surfaceProvider) }
        val analysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
            .setResolutionSelector(
                ResolutionSelector.Builder().setResolutionStrategy(
                    ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER),
                ).build(),
            )
            .build()
        analysis.setAnalyzer(analyzerExecutor) { image ->
            image.use {
                if (found.get()) return@use
                val plane = it.planes[0]
                val buffer = plane.buffer
                val luma = ByteArray(buffer.remaining()).also(buffer::get)
                val text = decodeQr(luma, it.width, it.height, plane.rowStride) ?: return@use
                if (found.compareAndSet(false, true)) mainExecutor.execute { if (!disposed) currentOnResult(text) }
            }
        }
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            if (disposed) return@addListener
            try {
                val cameras = future.get()
                val bound = cameras.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                provider = cameras
                camera = bound
                bound.cameraInfo.cameraState.observe(lifecycleOwner, stateObserver)
            } catch (_: Exception) {
                currentOnFailed()
            }
        }, mainExecutor)
        onDispose {
            disposed = true
            camera?.cameraInfo?.cameraState?.removeObserver(stateObserver)
            provider?.unbind(preview, analysis)
            analysis.clearAnalyzer()
            analyzerExecutor.shutdown()
        }
    }
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())
        Box(
            Modifier.align(Alignment.Center).size(240.dp)
                .border(3.dp, Color.White, RoundedCornerShape(16.dp)),
        )
        Column(
            Modifier.fillMaxSize().safeDrawingPadding().padding(24.dp),
            verticalArrangement = Arrangement.SpaceBetween,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                "Point the camera at the QR code on the PC",
                color = Color.White,
                style = MaterialTheme.typography.titleMedium,
                textAlign = TextAlign.Center,
                modifier = Modifier.background(Color.Black.copy(alpha = 0.6f), RoundedCornerShape(8.dp)).padding(12.dp),
            )
            Button(onClick = onCancel, modifier = Modifier.widthIn(max = 600.dp).fillMaxWidth()) { Text("Cancel") }
        }
    }
}
