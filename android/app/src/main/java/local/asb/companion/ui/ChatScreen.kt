package local.asb.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import local.asb.companion.data.ChatReply
import local.asb.companion.data.ChatTurn
import local.asb.companion.net.AsbApi
import local.asb.companion.net.AsbError

/** The words of the states of the chat screen; Off, NoChat, and Failed as the contract names them. */
const val CHAT_OFF = "Turn on Send message text to phones on the PC to see the chat."
const val CHAT_NONE = "This session has no chat to show."
const val CHAT_FAILED = "Cannot load the chat. Retrying."
const val CHAT_OLDER = "Older turns are not shown."

/** The poll period of the chat screen while it shows. */
const val CHAT_POLL_MS = 5_000L

/** What the screen shows: the last good [reply] (turns and more), the switch off, no chat, or a failed read. */
internal data class ChatState(val reply: ChatReply? = null, val off: Boolean = false, val none: Boolean = false,
    val failed: Boolean = false)

/**
 * The state after a poll gave [result]: Off drops the text at once, NoChat and Failed keep the last turns, and a failed first
 * read shows the retry note alone.
 */
internal fun chatStateAfter(state: ChatState, result: AsbApi.ChatResult): ChatState = when (result) {
    is AsbApi.ChatResult.Shown -> ChatState(reply = result.reply)
    AsbApi.ChatResult.Off -> ChatState(off = true)
    AsbApi.ChatResult.NoChat -> ChatState(none = true)
    AsbApi.ChatResult.Failed -> ChatState(reply = state.reply, failed = true)
}

/** The chats of [load] now and then every [CHAT_POLL_MS] until the collection stops, as the screen shows and leaves. */
internal fun chatPolls(load: suspend () -> AsbApi.ChatResult): Flow<ChatState> = flow {
    var state = ChatState()
    while (true) {
        state = chatStateAfter(state, load())
        emit(state)
        delay(CHAT_POLL_MS)
    }
}

/**
 * The chat view of a Claude Desktop Code session: turns oldest first, a poll every [CHAT_POLL_MS] while the screen shows, and the
 * text in screen state only (no saved state, no file, no log).
 */
@Composable
fun ChatScreen(api: AsbApi, engine: String, id: String, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val colors = activityColors()
    var state by remember(id) { mutableStateOf(ChatState()) }
    val list = rememberLazyListState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // The first reply opens at its newest turn; a later poll keeps the place.
    var opened by remember(id) { mutableStateOf(false) }
    LaunchedEffect(api, engine, id, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            chatPolls { api.chat(id, engine) }.collect { next ->
                state = next
                val turns = next.reply?.turns
                if (turns != null && turns.isNotEmpty() && !opened) {
                    opened = true
                    repeat(2) { withFrameNanos {} }
                    list.scrollToItem(turns.lastIndex + 1)
                }
            }
        }
    }
    Scaffold(contentWindowInsets = SafeContentInsets, topBar = { ActivityTopBar("Chat", onBack) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).background(colors.background)) {
            val notice = when {
                state.off -> CHAT_OFF
                state.none -> CHAT_NONE
                state.failed -> CHAT_FAILED
                else -> null
            }
            notice?.let {
                Text(it, fontSize = 12.sp, color = colors.muted, modifier = Modifier.padding(horizontal = 16.dp, vertical = 16.dp)
                    .semantics { liveRegion = LiveRegionMode.Polite })
            }
            state.reply?.let { reply ->
                LazyColumn(state = list, contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (reply.more) item(key = "more") {
                        Text(CHAT_OLDER, fontSize = 12.sp, color = colors.muted, modifier = Modifier.fillMaxWidth(),
                            textAlign = TextAlign.Center)
                    }
                    itemsIndexed(reply.turns, key = { index, _ -> "turn$index" }) { _, turn -> ChatTurnRow(turn, colors) }
                }
            }
        }
    }
}

/** One turn: user on the right, assistant on the left, a peer on the left with its name above its text. A cut turn ends with … */
@Composable
private fun ChatTurnRow(turn: ChatTurn, colors: ActivityColors) {
    val user = turn.role == "user"
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (user) Alignment.End else Alignment.Start) {
        if (turn.role == "peer") Text(turn.name, fontSize = 11.sp, color = colors.muted,
            modifier = Modifier.padding(start = 4.dp, bottom = 2.dp))
        Column(Modifier.fillMaxWidth(.82f).background(if (user) colors.track else colors.rule, RoundedCornerShape(10.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp).semantics(mergeDescendants = true) {}) {
            Text(if (turn.cut) turn.text + "…" else turn.text, fontSize = 13.sp, color = colors.text)
        }
    }
}
