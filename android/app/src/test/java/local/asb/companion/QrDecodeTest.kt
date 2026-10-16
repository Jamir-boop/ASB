package local.asb.companion

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import local.asb.companion.ui.decodeQr
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QrDecodeTest {
    private val link = "asb://pair?v=2&a=lan%3A192.168.50.4&p=4630&f=${"a".repeat(64)}&c=${"a".repeat(27)}&n=PC"

    /** Draws the code 4 pixels per module with a quiet zone; rows are rowStride bytes apart. */
    private fun luma(text: String, rowStride: (Int) -> Int): Triple<ByteArray, Int, Int> {
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0)
        val scale = 4
        val quiet = 8 * scale
        val size = matrix.width * scale + 2 * quiet
        val stride = rowStride(size)
        val bytes = ByteArray(stride * size) { 255.toByte() }
        for (y in 0 until matrix.height) for (x in 0 until matrix.width) {
            if (!matrix[x, y]) continue
            for (dy in 0 until scale) for (dx in 0 until scale) {
                bytes[(quiet + y * scale + dy) * stride + quiet + x * scale + dx] = 0
            }
        }
        return Triple(bytes, size, stride)
    }

    @Test fun decodesAPairingLink() {
        val (bytes, size, stride) = luma(link) { it }
        assertEquals(link, decodeQr(bytes, size, size, stride))
    }

    @Test fun decodesRowsWithPadding() {
        val (bytes, size, stride) = luma(link) { it + 64 }
        assertEquals(link, decodeQr(bytes, size, size, stride))
    }

    @Test fun blankImageGivesNull() {
        assertNull(decodeQr(ByteArray(640 * 480) { 255.toByte() }, 640, 480, 640))
    }
}
