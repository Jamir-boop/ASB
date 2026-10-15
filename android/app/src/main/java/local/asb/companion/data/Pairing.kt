package local.asb.companion.data

import java.io.ByteArrayOutputStream
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

data class PairingInfo(
    val host: String,
    val port: Int,
    val fingerprint: String,
    val code: String,
    val serverName: String,
)

fun parsePairingUri(text: String): PairingInfo? = try {
    val uri = URI(text.trim())
    require(uri.scheme == "asb" && uri.rawAuthority == "pair")
    require(uri.rawPath.isNullOrEmpty() && uri.rawFragment == null)
    val values = mutableMapOf<String, String>()
    for (part in requireNotNull(uri.rawQuery).split('&')) {
        val pieces = part.split('=', limit = 2)
        require(pieces.size == 2)
        val key = decodeQueryPart(pieces[0])
        require(key !in values)
        values[key] = decodeQueryPart(pieces[1])
    }
    require(values.keys == setOf("v", "h", "p", "f", "c", "n"))
    require(values.getValue("v") == "1")
    val host = values.getValue("h")
    val octets = host.split('.')
    require(octets.size == 4 && octets.all {
        it.matches(Regex("0|[1-9][0-9]{0,2}")) && it.toInt() <= 255
    })
    val portText = values.getValue("p")
    require(portText.matches(Regex("[1-9][0-9]{0,4}")))
    val port = portText.toInt()
    require(port in 1..65535)
    val fingerprint = values.getValue("f")
    require(fingerprint.matches(Regex("[0-9a-f]{64}")))
    val code = values.getValue("c")
    require(code.matches(Regex("[A-Za-z0-9_-]{27}")))
    PairingInfo(host, port, fingerprint, code, values.getValue("n"))
} catch (_: Exception) {
    null
}

private fun decodeQueryPart(raw: String): String {
    val bytes = ByteArrayOutputStream()
    var index = 0
    while (index < raw.length) {
        val character = raw[index]
        if (character == '%') {
            require(index + 2 < raw.length)
            bytes.write(raw.substring(index + 1, index + 3).toInt(16))
            index += 3
        } else {
            require(character.code < 128)
            bytes.write(character.code)
            index++
        }
    }
    return Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
}
