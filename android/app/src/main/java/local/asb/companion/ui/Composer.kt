package local.asb.companion.ui

import java.security.SecureRandom
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import local.asb.companion.net.MessageReply
import kotlinx.coroutines.delay

/** The engine limit of a message from the phone, in code points. */
const val MESSAGE_LIMIT = 4_000
const val MESSAGE_SENT = "Sent."
const val MESSAGE_SENT_WORKING = "Sent. The session reads it during its current work."
const val MESSAGE_FAILED = "Not sent. Retry."
const val MESSAGE_SENDING = "Sending"

/** The line of a row that cannot get a message now, by its code; `unsupported` has none, and a missing field has no composer. */
fun messageReasonLine(reason: String): String? = when (reason) {
    "not-live" -> "Open the session on the PC to send a message."
    "relay" -> "The ASB message relay is not running on the PC."
    else -> null
}

private val messageRandom = SecureRandom()

/** A new 32 lowercase hex message ID, as the engine takes it. */
internal fun newMessageId(random: SecureRandom = messageRandom): String =
    ByteArray(16).also(random::nextBytes).joinToString("") { "%02x".format(it) }

/** [text] cut to [limit] code points, as the engine counts; a cut never splits a surrogate pair. */
internal fun takeCodePoints(text: String, limit: Int): String =
    if (text.codePointCount(0, text.length) <= limit) text else text.substring(0, text.offsetByCodePoints(0, limit))

enum class ComposerStatus { Ready, Sending, Sent, Failed, Refused }

/**
 * The composer of the chat screen: the draft, the message ID of this draft, and its state. The draft and every text stay in
 * screen state only: never saved, logged, or in a notification. The engine keys a send by (row, messageId), so any new draft
 * after a send attempt gets a new ID.
 */
data class Composer(
    val draft: String = "",
    val messageId: String = newMessageId(),
    val status: ComposerStatus = ComposerStatus.Ready,
    val serverText: String = "",
) {
    val locked: Boolean get() = status == ComposerStatus.Sending

    fun type(text: String): Composer {
        if (locked) return this
        val value = takeCodePoints(text, MESSAGE_LIMIT)
        if (value == draft) return this
        // After an attempt the text is a new draft: a new ID, so the PC never answers it with the old attempt's stored reply.
        return copy(draft = value, status = ComposerStatus.Ready, serverText = "",
            messageId = if (status == ComposerStatus.Ready) messageId else newMessageId())
    }

    fun sending(): Composer = copy(status = ComposerStatus.Sending, serverText = "")

    /** [reply] is null after a network error. Sent clears the field and makes the next draft's ID new. */
    fun replied(reply: MessageReply?): Composer = when (reply) {
        MessageReply.Sent -> Composer(messageId = newMessageId(), status = ComposerStatus.Sent)
        is MessageReply.Refused -> copy(status = ComposerStatus.Refused, serverText = reply.message)
        MessageReply.Failed, null -> copy(status = ComposerStatus.Failed)
    }

    fun canSend(): Boolean = !locked && draft.isNotBlank()

    /** The state line under the field; [working] adds the wait note to Sent. */
    fun note(working: Boolean): String? = when (status) {
        ComposerStatus.Ready -> null
        ComposerStatus.Sending -> MESSAGE_SENDING
        ComposerStatus.Sent -> if (working) MESSAGE_SENT_WORKING else MESSAGE_SENT
        ComposerStatus.Failed -> MESSAGE_FAILED
        ComposerStatus.Refused -> serverText
    }
}

/** After Sent the chat reads at once, and once more after 2 s. */
internal suspend fun refreshAfterSend(refresh: () -> Unit) {
    refresh()
    delay(2_000)
    refresh()
}

/** The composer at the bottom of the chat: a multi-line field, Send, and the state line. */
@Composable
internal fun MessageComposer(composer: Composer, working: Boolean, onType: (String) -> Unit, onSend: () -> Unit) {
    val colors = activityColors()
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        OutlinedTextField(
            value = composer.draft,
            onValueChange = onType,
            enabled = !composer.locked,
            label = { Text("Message") },
            textStyle = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            val note = composer.note(working)
            if (note != null) Text(note, fontSize = 11.sp, color = colors.muted, maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite })
            else Spacer(Modifier.weight(1f))
            Button(onClick = onSend, enabled = composer.canSend(), shape = RoundedCornerShape(8.dp),
                modifier = Modifier.heightIn(min = 48.dp)) {
                Text(if (composer.status == ComposerStatus.Failed) "Retry" else "Send", fontSize = 13.sp,
                    fontWeight = FontWeight.Bold)
            }
        }
    }
}
