package local.asb.companion

import local.asb.companion.data.ENDPOINT_KINDS
import local.asb.companion.data.Endpoint
import local.asb.companion.data.Engine
import local.asb.companion.data.endpointLabel
import local.asb.companion.data.orderEndpoints
import local.asb.companion.data.otherEngines
import local.asb.companion.data.parsePairingUri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class PairingTest {
    private val fingerprint = "ab".repeat(32)
    private val code = "A_z-" + "0".repeat(23)
    private val link = "asb://pair?v=1&h=192.168.50.4&p=4630&f=$fingerprint&c=$code&n=Debian%20PC"

    @Test fun pairingLinkComesOnlyFromAViewIntentWithAnAsbPairUri() {
        assertEquals(link, pairingLink("android.intent.action.VIEW", link))
        assertNull(pairingLink("android.intent.action.MAIN", link))
        assertNull(pairingLink("android.intent.action.VIEW", null))
        assertNull(pairingLink("android.intent.action.VIEW", "https://example.com/pair"))
        assertNull(pairingLink(null, link))
    }

    @Test fun validPairingLink() {
        val info = parsePairingUri(link)!!
        assertEquals(listOf(Endpoint("lan", "192.168.50.4")), info.addresses)
        assertEquals(4630, info.port)
        assertEquals(fingerprint, info.fingerprint)
        assertEquals(code, info.code)
        assertEquals("Debian PC", info.serverName)
    }

    @Test fun encodedNameAndLiteralPlus() {
        assertEquals("PC + 手机", parsePairingUri(link.substringBefore("&n=") + "&n=PC%20%2B%20%E6%89%8B%E6%9C%BA")!!.serverName)
        assertEquals("PC+Name", parsePairingUri(link.substringBefore("&n=") + "&n=PC+Name")!!.serverName)
        assertEquals("", parsePairingUri(link.substringBefore("&n=") + "&n=")!!.serverName)
        assertEquals("手".repeat(64), parsePairingUri(link.substringBefore("&n=") + "&n=" + "%E6%89%8B".repeat(64))!!.serverName)
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
            "n=Debian%20PC" to "n=%ZZ", "n=Debian%20PC" to "n=PC%0ACertificate",
            "n=Debian%20PC" to "n=PC%09", "n=Debian%20PC" to "n=PC%C2%85", "n=Debian%20PC" to "n=${"a".repeat(65)}",
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

    private val v2 = "asb://pair?v=2&a=lan%3A192.168.50.4%2Czerotier%3A10.147.17.4%2Ctailscale%3A100.101.102.103" +
        "&p=4630&f=$fingerprint&c=$code&n=Debian%20PC"

    @Test fun version2LinkGivesEndpointsInKindOrder() {
        val info = parsePairingUri(v2)!!
        assertEquals(listOf(Endpoint("lan", "192.168.50.4"), Endpoint("zerotier", "10.147.17.4"),
            Endpoint("tailscale", "100.101.102.103")), info.addresses)
        assertEquals(4630, info.port)
        assertEquals(fingerprint, info.fingerprint)
        assertEquals(code, info.code)
        assertEquals("Debian PC", info.serverName)
        val reversed = v2.replace(Regex("a=[^&]*"), "a=tailscale:100.101.102.103,lan:192.168.50.4")
        assertEquals(listOf("lan", "tailscale"), parsePairingUri(reversed)!!.addresses.map { it.kind })
    }

    @Test fun version2DropsUnknownKindsAndNeedsOneAddress() {
        val dropped = v2.replace(Regex("a=[^&]*"), "a=wireguard%3A10.0.0.9%2Ctailscale%3A100.101.102.103")
        assertEquals(listOf(Endpoint("tailscale", "100.101.102.103")), parsePairingUri(dropped)!!.addresses)
        for (list in listOf("wireguard:10.0.0.9", "", "lan", "lan:", "lan:192.168.50", "lan:host",
            "lan:192.168.50.4,zerotier:10.147.17.256", "lan:192.168.50.4,,zerotier:10.147.17.4")) {
            assertNull("Rejected list: $list", parsePairingUri(v2.replace(Regex("a=[^&]*"), "a=$list")))
        }
    }

    @Test fun version2RejectsBadFields() {
        for ((old, new) in listOf("p=4630" to "p=0", "p=4630" to "p=65536", "f=$fingerprint" to "f=${fingerprint.drop(1)}",
            "c=$code" to "c=${code.drop(1)}", "v=2" to "v=3", "a=" to "h=", "&n=Debian%20PC" to "")) {
            assertNull("Rejected field: $old", parsePairingUri(v2.replace(old, new)))
        }
        assertNull(parsePairingUri("$v2&h=192.168.50.4"))
        assertNull(parsePairingUri(link.replace("v=1", "v=2")))
    }

    @Test fun endpointOrderKeepsKnownKindsOnce() {
        assertEquals(listOf(Endpoint("lan", "192.168.50.4"), Endpoint("zerotier", "10.147.17.4"),
            Endpoint("tailscale", "100.101.102.103")), orderEndpoints(listOf(
            Endpoint("tailscale", "100.101.102.103"), Endpoint("vpn", "10.0.0.9"), Endpoint("zerotier", "10.147.17.4"),
            Endpoint("lan", "192.168.50.4"), Endpoint("lan", "not an address"), Endpoint("zerotier", "192.168.50.4"))))
        assertEquals(listOf("Home network", "ZeroTier", "Tailscale"), ENDPOINT_KINDS.map(::endpointLabel))
    }

    @Test fun otherEnginesKeepValidMembersInOrderWithoutThePairedPc() {
        val paired = "a".repeat(64)
        fun engine(n: Int, vararg addresses: Endpoint) = Engine("%016x".format(n), "pc$n", 4630, "%064x".format(n), addresses.toList())
        val zerotier = Endpoint("zerotier", "10.147.0.2")
        val lan = Endpoint("lan", "192.168.1.20")
        val good = engine(1, zerotier, Endpoint("vpn", "10.0.0.1"), lan)
        val list = listOf(
            engine(9, lan).copy(fingerprint = paired),
            good,
            engine(2, lan).copy(machineId = "B".repeat(16)),
            engine(3, lan).copy(fingerprint = "f".repeat(63)),
            engine(4, lan).copy(port = 0),
            engine(5, lan).copy(port = 65536),
            engine(6, lan).copy(name = "my laptop"),
            engine(7, lan).copy(name = "-pc"),
            engine(8, Endpoint("lan", "not an address")),
            engine(10, lan).copy(machineId = good.machineId),
            engine(11, lan).copy(fingerprint = good.fingerprint),
            engine(12, lan).copy(name = "a".repeat(32)),
        )
        assertEquals(listOf(good.copy(addresses = listOf(lan, zerotier)), engine(12, lan).copy(name = "a".repeat(32))),
            otherEngines(list, paired))
        assertEquals(32, otherEngines((1..40).map { engine(it, lan) }, paired).size)
        assertEquals("%016x".format(1), otherEngines((1..40).map { engine(it, lan) }, paired).first().machineId)
    }
}
