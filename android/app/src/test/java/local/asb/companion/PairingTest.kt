package local.asb.companion

import local.asb.companion.data.parsePairingUri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class PairingTest {
    private val fingerprint = "ab".repeat(32)
    private val code = "A_z-" + "0".repeat(23)
    private val link = "asb://pair?v=1&h=192.168.50.4&p=4630&f=$fingerprint&c=$code&n=Debian%20PC"

    @Test fun validPairingLink() {
        val info = parsePairingUri(link)!!
        assertEquals("192.168.50.4", info.host)
        assertEquals(4630, info.port)
        assertEquals(fingerprint, info.fingerprint)
        assertEquals(code, info.code)
        assertEquals("Debian PC", info.serverName)
    }

    @Test fun encodedNameAndLiteralPlus() {
        assertEquals("PC + 手机", parsePairingUri(link.substringBefore("&n=") + "&n=PC%20%2B%20%E6%89%8B%E6%9C%BA")!!.serverName)
        assertEquals("PC+Name", parsePairingUri(link.substringBefore("&n=") + "&n=PC+Name")!!.serverName)
        assertEquals("", parsePairingUri(link.substringBefore("&n=") + "&n=")!!.serverName)
    }

    @Test fun invalidFieldsAreRejected() {
        val changes = listOf(
            "asb://" to "https://", "pair?" to "other?", "v=1" to "v=2",
            "h=192.168.50.4" to "h=256.168.50.4", "h=192.168.50.4" to "h=192.168.50",
            "h=192.168.50.4" to "h=192.168.050.4", "h=192.168.50.4" to "h=localhost",
            "p=4630" to "p=0", "p=4630" to "p=65536", "p=4630" to "p=-1",
            "p=4630" to "p=04630", "f=$fingerprint" to "f=${fingerprint.uppercase()}",
            "f=$fingerprint" to "f=${fingerprint.drop(1)}", "c=$code" to "c=${code.drop(1)}",
            "c=$code" to "c=${code.dropLast(1)}!", "n=Debian%20PC" to "n=%FF",
            "n=Debian%20PC" to "n=%ZZ",
        )
        for ((old, new) in changes) assertNull("Rejected field: $old", parsePairingUri(link.replace(old, new)))
    }

    @Test fun ambiguousOrIncompleteLinksAreRejected() {
        for (value in listOf(
            "", "asb://pair", link + "#fragment", link + "&h=10.0.0.1",
            link + "&%68=10.0.0.1", link + "&extra=1", link + "&", link.replace("pair?", "pair/path?"),
            link.replace("pair?", "user@pair?"), link.replace("pair?", "pair:4630?"),
            link.substringBefore("&n="),
            link.replace("?v=1&", "?"), link.replace("&p=4630", ""),
        )) assertNull(parsePairingUri(value))
        assertNotNull(parsePairingUri(link))
    }
}
