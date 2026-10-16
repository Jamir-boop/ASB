package local.asb.companion

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * Takes the asb://pair link and gives it to the one MainActivity. MainActivity keeps the standard
 * launch mode, so a launcher tap does not close a permission dialog or a settings page above it.
 */
class PairLinkActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startActivity(Intent(this, MainActivity::class.java)
            .setAction(intent.action)
            .setData(intent.data)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }
}
