package local.asb.companion.net

import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import okhttp3.ConnectionPool
import okhttp3.ConnectionSpec
import okhttp3.OkHttpClient
import okhttp3.TlsVersion

fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(bytes).joinToString("") { "%02x".format(it) }

fun pinnedClient(fingerprintHex: String): OkHttpClient {
    require(fingerprintHex.matches(Regex("[0-9a-f]{64}"))) { "Invalid certificate fingerprint" }
    val trust = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
            throw CertificateException("Client certificates are not used")

        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
            if (chain.isEmpty() || sha256Hex(chain[0].encoded) != fingerprintHex) {
                throw CertificateException("ASB certificate does not match the paired PC")
            }
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
    val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
    return OkHttpClient.Builder()
        .sslSocketFactory(ssl.socketFactory, trust)
        .hostnameVerifier { _, session ->
            val cert = session.peerCertificates.firstOrNull() as? X509Certificate
            cert != null && sha256Hex(cert.encoded) == fingerprintHex
        }
        .connectionSpecs(listOf(ConnectionSpec.Builder(ConnectionSpec.RESTRICTED_TLS)
            .tlsVersions(TlsVersion.TLS_1_3).build()))
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        // No retry, so drop idle connections before the gateway closes them (it keeps them 65 s).
        .connectionPool(ConnectionPool(2, 30, TimeUnit.SECONDS))
        // Short, so a GET can try the next endpoint soon when one does not answer.
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(35, TimeUnit.SECONDS)
        .build()
}
