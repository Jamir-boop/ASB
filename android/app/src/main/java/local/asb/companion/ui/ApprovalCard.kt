package local.asb.companion.ui

import local.asb.companion.data.PhoneApproval
import local.asb.companion.data.PhoneQuestion
import local.asb.companion.data.Thread
import local.asb.companion.net.AnswerReply
import local.asb.companion.net.Decision

/** The engine limit of the deny note, in UTF-16 units (String.length), as the engine counts. */
const val NOTE_LIMIT = 500

fun noteLabel(approval: PhoneApproval): String = "Note for the agent (sent with ${approvalLabels(approval).deny})"
const val APPROVAL_CLOSED = "This request is closed."

data class KeptApproval(val approval: PhoneApproval?, val closed: Boolean)

/** As [keptQuestion]: an approval that leaves the row stays in place, closed, until the inspector closes. */
fun keptApproval(kept: PhoneApproval?, live: PhoneApproval?): KeptApproval =
    KeptApproval(live ?: kept, closed = live == null && kept != null)

/** The approval card wins over the question card; a closed kept approval gives way to a live question. */
fun approvalWins(approval: KeptApproval, liveQuestion: PhoneQuestion?): Boolean =
    approval.approval != null && (!approval.closed || liveQuestion == null)

/** The outlined (deny) and the filled (allow) button labels of a kind. */
data class ApprovalLabels(val deny: String, val allow: String)

fun approvalLabels(approval: PhoneApproval): ApprovalLabels =
    if (approval.kind == "plan") ApprovalLabels("Keep planning", "Approve plan") else ApprovalLabels("Deny", "Allow once")

/** What TalkBack reads first for the card; the display items follow. */
fun approvalHeading(approval: PhoneApproval): String = "Approval request: ${approval.title}"

/**
 * The approval card of the inspector: the typed deny note and the state, in memory only.
 */
data class ApprovalCard(val requestId: String, val note: String = "", val status: CardStatus = CardStatus.Ready, val armed: Boolean = false) {
    constructor(approval: PhoneApproval) : this(approval.requestId)

    val locked: Boolean get() = status == CardStatus.Sending || status == CardStatus.Sent || status == CardStatus.Closed

    fun type(text: String): ApprovalCard {
        if (locked) return this
        var value = text.take(NOTE_LIMIT)
        // A cut between the two halves of a surrogate pair would send half a character.
        if (value.length < text.length && value.isNotEmpty() && Character.isHighSurrogate(value.last())) value = value.dropLast(1)
        return copy(note = value)
    }

    /** The note for the body: only for a deny of an approval that takes one, cleaned, and not blank. */
    fun noteFor(approval: PhoneApproval, decision: Decision): String? =
        if (!approval.note || decision != Decision.Deny) null else cleanOther(note).takeIf { it.isNotBlank() }

    fun canDecide(offline: Boolean, closed: Boolean = false, armed: Boolean = this.armed): Boolean =
        armed && !closed && !locked && !offline

    fun arm(): ApprovalCard = copy(armed = true)

    fun sending(): ApprovalCard = copy(status = CardStatus.Sending)

    /** [reply] is null after a network or other error: the buttons work again, and the inspector shows the error. */
    fun replied(reply: AnswerReply?): ApprovalCard = when (reply) {
        null -> copy(status = CardStatus.Ready)
        // The request is over, so the typed note goes too.
        AnswerReply.Sent -> copy(status = CardStatus.Sent, note = "")
        AnswerReply.Closed -> copy(status = CardStatus.Closed, note = "")
        AnswerReply.Off -> copy(status = CardStatus.Off)
        AnswerReply.Refused -> copy(status = CardStatus.Refused)
        // Only a next-step question reply carries the PC's text, never an approval.
        is AnswerReply.Text -> copy(status = CardStatus.Refused)
    }

    /** The muted state line under the buttons' row, or null. */
    fun line(offline: Boolean, closed: Boolean = false): String? = when {
        closed -> APPROVAL_CLOSED
        status == CardStatus.Sending -> "Sending"
        status == CardStatus.Sent -> "Sent"
        status == CardStatus.Closed -> "Answered on the PC"
        offline -> "Offline"
        status == CardStatus.Off -> "Approvals are off on the PC."
        status == CardStatus.Refused -> "The PC did not take this answer."
        else -> null
    }

    /** The filled button's TalkBack text on a closed card, else null (the label is read). */
    fun allowDescription(approval: PhoneApproval, closed: Boolean): String? =
        if (closed) "${approvalLabels(approval).allow}, this request is closed" else null
}

/**
 * The row whose inspector a notification tap opens: a row with an open question or approval.
 */
fun answerRowToOpen(tag: String, rows: List<Thread>): Thread? {
    val key = tag.substringBeforeLast(':', "").ifEmpty { return null }
    return rows.firstOrNull { it.key == key && (it.question != null || it.approval != null) }
}
