package local.asb.companion.ui

import local.asb.companion.data.PhoneAnswer
import local.asb.companion.data.PhoneQuestion
import local.asb.companion.net.AnswerReply

/** The engine limit of the Other text, in UTF-16 units (String.length), as the engine counts. */
const val OTHER_LIMIT = 2_000

/** The Other limit of a next-step reply, as the engine takes it. */
const val NEXT_STEP_OTHER_LIMIT = 4_000

const val SEND_NOT_READY = "Send, answer each question first"
const val QUESTION_CLOSED = "This question is closed."
const val SEND_CLOSED = "Send, this question is closed"

/** The help line of the next-step card, under its reply choices. */
const val NEXT_STEP_HELP = "The agent gets this as a message from your phone. For risky steps it can still ask on the PC."

/** The line of a next-step card that the PC cannot take the answer now, when the engine sends none. */
const val NEXT_STEP_UNAVAILABLE = "Open the session on the PC to answer."

/** The Other limit of a question: wider for a next-step reply. */
fun otherLimit(question: PhoneQuestion): Int =
    if (question.kind == "next-step") NEXT_STEP_OTHER_LIMIT else OTHER_LIMIT

/** True when the next-step card shows only its words and the reason: no options, no Other, no Send. */
fun nextStepBlocked(question: PhoneQuestion): Boolean = question.kind == "next-step" && !question.live

/** The reason line of a blocked next-step card, in the engine's words or the default. */
fun nextStepUnavailable(question: PhoneQuestion): String = question.unavailable.ifEmpty { NEXT_STEP_UNAVAILABLE }

/** The app actions of a next-step card, as plain lines: the agent can do these itself on the PC. */
fun nextStepActionLines(question: PhoneQuestion): List<String> = question.appActions.map { "On the PC: $it" }

data class KeptCard(val question: PhoneQuestion?, val closed: Boolean)

fun keptQuestion(kept: PhoneQuestion?, live: PhoneQuestion?): KeptCard =
    KeptCard(live ?: kept, closed = live == null && kept != null)

enum class CardStatus { Ready, Sending, Sent, Closed, Off, Refused, ServerText }

/**
 * The question card of the inspector: the chosen labels and the Other text of each question, in memory only.
 * [serverText] is the PC's own words for a next-step answer that it refused (a 409 or 429), shown as it is.
 */
data class QuestionCard(
    val requestId: String,
    val selected: List<List<String>>,
    val other: List<String>,
    val status: CardStatus = CardStatus.Ready,
    val serverText: String = "",
) {
    constructor(question: PhoneQuestion) : this(question.requestId, question.questions.map { emptyList() }, question.questions.map { "" })

    /** The choices cannot change while the answer is sent or after the PC has it. */
    val locked: Boolean get() = status == CardStatus.Sending || status == CardStatus.Sent || status == CardStatus.Closed

    fun choose(question: PhoneQuestion, index: Int, label: String): QuestionCard {
        if (locked) return this
        val item = question.questions[index]
        val now = selected[index]
        val next = if (!item.multiSelect) listOf(label)
            // The options order, so the body does not depend on the tap order.
            else item.options.map { it.label }.filter { if (it == label) it !in now else it in now }
        return copy(selected = selected.replace(index, next),
            other = if (item.multiSelect) other else other.replace(index, ""))
    }

    fun type(question: PhoneQuestion, index: Int, text: String): QuestionCard {
        if (locked || !question.questions[index].allowOther) return this
        var value = text.take(otherLimit(question))
        // A cut between the two halves of a surrogate pair would send half a character.
        if (value.length < text.length && value.isNotEmpty() && Character.isHighSurrogate(value.last())) value = value.dropLast(1)
        val single = !question.questions[index].multiSelect
        return copy(other = other.replace(index, value),
            selected = if (single && value.isNotEmpty()) selected.replace(index, emptyList()) else selected)
    }

    /** The answer items for the body, or null while a question has no valid answer. */
    fun answers(question: PhoneQuestion): List<PhoneAnswer>? {
        if (question.requestId != requestId || question.questions.size != selected.size) return null
        return question.questions.mapIndexed { index, item ->
            val labels = selected[index]
            val text = if (item.allowOther) cleanOther(other[index]).takeIf { it.isNotBlank() } else null
            val count = labels.size + if (text != null) 1 else 0
            if (if (item.multiSelect) count < 1 else count != 1) return null
            PhoneAnswer(labels, text)
        }
    }

    fun canSend(question: PhoneQuestion, offline: Boolean, closed: Boolean = false): Boolean =
        !closed && !locked && !offline && answers(question) != null

    fun sendDescription(question: PhoneQuestion, closed: Boolean): String? = when {
        closed -> SEND_CLOSED
        !locked && answers(question) == null -> SEND_NOT_READY
        else -> null
    }

    fun sending(): QuestionCard = copy(status = CardStatus.Sending)

    /** [reply] is null after a network or other error: the card can send again, and the inspector shows the error. */
    fun replied(reply: AnswerReply?): QuestionCard = copy(status = when (reply) {
        null -> CardStatus.Ready
        AnswerReply.Sent -> CardStatus.Sent
        AnswerReply.Closed -> CardStatus.Closed
        AnswerReply.Off -> CardStatus.Off
        AnswerReply.Refused -> CardStatus.Refused
        is AnswerReply.Text -> CardStatus.ServerText
    }, serverText = (reply as? AnswerReply.Text)?.message ?: "")

    /** The muted state line under the questions, or null. */
    fun note(offline: Boolean, closed: Boolean = false): String? = when {
        closed -> QUESTION_CLOSED
        status == CardStatus.Sending -> "Sending"
        status == CardStatus.Sent -> "Sent"
        status == CardStatus.Closed -> "Answered on the PC"
        offline -> "Offline"
        status == CardStatus.Off -> "Answers are off on the PC."
        status == CardStatus.Refused -> "The PC did not take this answer."
        status == CardStatus.ServerText -> serverText
        else -> null
    }
}

private fun <T> List<T>.replace(index: Int, value: T): List<T> = toMutableList().also { it[index] = value }

/** The engine refuses control characters except a newline and a tab. */
fun cleanOther(text: String): String = text.filterNot { (it < ' ' && it != '\n' && it != '\t') || it == '\u007f' }

/** A tap on a notification at [atMs]; the screen acts on it after the first dashboard read after that time. */
data class QuestionTap(val tag: String, val atMs: Long)
