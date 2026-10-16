package local.asb.companion.ui

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.ChecksumException
import com.google.zxing.DecodeHintType
import com.google.zxing.FormatException
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

private val QrHints = mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE))

/** Reads one QR code from a luma (Y) plane whose rows are rowStride bytes apart. */
fun decodeQr(luma: ByteArray, width: Int, height: Int, rowStride: Int): String? {
    val source = PlanarYUVLuminanceSource(luma, rowStride, height, 0, 0, width, height, false)
    return try {
        QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source)), QrHints).text
    } catch (_: NotFoundException) {
        null
    } catch (_: ChecksumException) {
        null
    } catch (_: FormatException) {
        null
    }
}
