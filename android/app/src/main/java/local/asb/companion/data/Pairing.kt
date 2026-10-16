package local.asb.companion.data

import java.io.ByteArrayOutputStream
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** One address of the paired PC; the pin and the token are the same for all of them. */
@Serializable
data class Endpoint(val kind: String = "", @SerialName("address") val host: String = "")

/** The order in which the app tries the addresses of the PC. */
val ENDPOINT_KINDS = listOf("lan", "zerotier", "tailscale")

fun endpointLabel(kind: String): String = when (kind) {
    "zerotier" -> "ZeroTier"
    "tailscale" -> "Tailscale"
    else -> "Home network"
}

/** Keeps the known kinds with an IPv4 address, once per address, in the order of [ENDPOINT_KINDS]. */
fun orderEndpoints(list: List<Endpoint>): List<Endpoint> =
    list.filter { it.kind in ENDPOINT_KINDS && isIpv4(it.host) }.distinctBy { it.host }
        .sortedBy { ENDPOINT_KINDS.indexOf(it.kind) }

private fun isIpv4(text: String): Boolean = text.split('.').let { octets ->
    octets.size == 4 && octets.all { it.matches(Regex("0|[1-9][0-9]{0,2}")) && it.toInt() <= 255 }
}

data class PairingInfo(
    val addresses: List<Endpoint>,
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
    val addresses = when (values["v"]) {
        "1" -> {
            require(values.keys == setOf("v", "h", "p", "f", "c", "n"))
            listOf(Endpoint("lan", values.getValue("h")).also { require(isIpv4(it.host)) })
        }
        "2" -> {
            require(values.keys == setOf("v", "a", "p", "f", "c", "n"))
            // Unknown kinds are dropped, so a newer PC can add kinds; a known kind needs a valid address.
            values.getValue("a").split(',').mapNotNull { item ->
                val pieces = item.split(':', limit = 2)
                require(pieces.size == 2)
                if (pieces[0] !in ENDPOINT_KINDS) null
                else Endpoint(pieces[0], pieces[1]).also { require(isIpv4(it.host)) }
            }
        }
        else -> throw IllegalArgumentException()
    }.let(::orderEndpoints)
    require(addresses.isNotEmpty())
    val portText = values.getValue("p")
    require(portText.matches(Regex("[1-9][0-9]{0,4}")))
    val port = portText.toInt()
    require(port in 1..65535)
    val fingerprint = values.getValue("f")
    require(fingerprint.matches(Regex("[0-9a-f]{64}")))
    val code = values.getValue("c")
    require(code.matches(Regex("[A-Za-z0-9_-]{27}")))
    val name = values.getValue("n")
    // The same rule as the PC applies to device names, so a link cannot add lines to the Check the PC screen.
    require(name.codePointCount(0, name.length) <= 64 && !name.contains(Regex("[\\x00-\\x1f\\x7f-\\x9f]")))
    PairingInfo(addresses, port, fingerprint, code, name)
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
