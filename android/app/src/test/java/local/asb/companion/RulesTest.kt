package local.asb.companion

import java.security.MessageDigest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import local.asb.companion.data.Thread
import local.asb.companion.data.Message
import local.asb.companion.ui.APP_FILTERS
import local.asb.companion.ui.Filter
import local.asb.companion.ui.MESSAGE_FLIGHT_LIMIT
import local.asb.companion.ui.MESSAGE_MAX_AGE_MS
import local.asb.companion.ui.MenuAction
import local.asb.companion.ui.PanelControl
import local.asb.companion.ui.STATES
import local.asb.companion.ui.actionNeedsAttention
import local.asb.companion.ui.attentionIndicator
import local.asb.companion.ui.casefold
import local.asb.companion.ui.clockInterval
import local.asb.companion.ui.filteredRows
import local.asb.companion.ui.keepIndexOnChange
import local.asb.companion.ui.keptPosition
import local.asb.companion.ui.limitLeft
import local.asb.companion.ui.messageControl
import local.asb.companion.ui.messageDuration
import local.asb.companion.ui.newMessages
import local.asb.companion.ui.panelFocusReturn
import local.asb.companion.ui.pinMoveBody
import local.asb.companion.ui.providerIcon
import local.asb.companion.ui.providerQuery
import local.asb.companion.ui.rowMenuActions
import local.asb.companion.ui.rowPanelControls
import local.asb.companion.ui.rowPanelNote
import local.asb.companion.ui.startIndex
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RulesTest {
    private val now = 1_790_000_000_000L
    private val fixture = listOf(
        Thread(id = "first", provider = "codex", providerLabel = "Codex",
            title = "Verify native session switching", cwd = "/example/ASB", projectName = "ASB",
            state = "working", canOpen = true, updatedAtMs = now, nativeUnread = true, nativeAttention = true),
        Thread(id = "second", provider = "codex", providerLabel = "Codex",
            title = "Check keyboard focus after refresh", cwd = "/example/ASB", projectName = "ASB",
            state = "idle", canOpen = true, updatedAtMs = now - 60_000, pending = true, unread = true),
        Thread(id = "unknown", provider = "codex", providerLabel = "Codex",
            title = "A session without a desktop link", cwd = "/example/Tools", projectName = "Tools",
            state = "unknown", updatedAtMs = now - 300_000),
        Thread(id = "claude:local_mock", provider = "claude-desktop-code", providerLabel = "Claude Desktop Code",
            title = "Choose the folder for the next check", cwd = "/example/Notes", projectName = "Notes",
            state = "waiting", canOpen = true, updatedAtMs = now - 120_000, pending = true, actionRequired = true),
        Thread(id = "archive", provider = "codex", providerLabel = "Codex", title = "Completed setup",
            cwd = "/example/ASB", projectName = "ASB", state = "idle", canOpen = true, archived = true,
            updatedAtMs = now - 3_600_000),
    )

    private fun ids(rows: List<Thread> = fixture, filter: Filter = Filter()) =
        filteredRows(rows, filter).map { it.id }

    @Test fun filtersStateOrderPendingAndArchive() {
        assertEquals(listOf("second", "claude:local_mock", "first", "unknown"), ids())
        assertEquals(5, ids(filter = Filter(archived = true)).size)
        for ((query, expected) in listOf(
            "SWITCHING" to listOf("first"), "/example/Notes" to listOf("claude:local_mock"),
            "Claude Desktop" to listOf("claude:local_mock"), "missing" to emptyList(),
        )) assertEquals(expected, ids(filter = Filter(query = query)))
        assertEquals(listOf("unknown"), ids(filter = Filter(app = "codex", states = setOf("unknown"))))
        assertEquals(listOf("second", "claude:local_mock"), ids(filter = Filter(pendingOnly = true)))
        assertEquals(listOf("second", "first"), ids(filter = Filter(states = setOf("working", "idle"))))
        assertEquals(emptyList<String>(), ids(filter = Filter(states = emptySet())))
        assertEquals(listOf("second"), ids(filter = Filter(states = setOf("working", "idle"), pendingOnly = true)))
        val pinned = fixture.map { when (it.id) {
            "first" -> it.copy(pinned = true, pinIndex = 1)
            "unknown" -> it.copy(pinned = true, pinIndex = 0)
            else -> it
        } }
        assertEquals(listOf("unknown", "first", "second", "claude:local_mock"), ids(pinned))
        assertEquals(listOf("first", "second"), ids(pinned, Filter(query = "cx:", states = setOf("working", "idle"))))
        assertEquals(listOf("working", "waiting", "idle", "unknown"), STATES)
    }

    @Test fun providerPrefixesOverrideTheAppFilterAndKeepLiteralQueries() {
        for (prefix in listOf("cl:", "claude:", " CL : ", "ClaUde: ", "cx:", "codex:", " CX : ", "CODEX:")) {
            val provider = if (prefix.trim().startsWith("cl", true)) "claude-desktop-code" else "codex"
            val opposite = if (provider == "codex") "claude-desktop-code" else "codex"
            val selected = filteredRows(fixture, Filter(query = prefix, app = opposite))
            assertTrue(prefix, selected.isNotEmpty())
            assertTrue(prefix, selected.all { it.provider == provider })
        }
        assertEquals(listOf("claude:local_mock"), ids(filter = Filter(query = "CL: CHOOSE THE FOLDER")))
        assertEquals(listOf("second"), ids(filter = Filter(query = "codex: /example/ASB", pendingOnly = true)))
        assertEquals(4, ids(filter = Filter(query = "cx:", archived = true)).size)
        assertEquals(emptyList<String>(), ids(filter = Filter(query = "claude:", states = setOf("working"))))
        assertEquals("notes: <b>" to "all", providerQuery("notes: <b>"))
        assertEquals(listOf("literal"), ids(listOf(fixture[0].copy(id = "literal", title = "notes: <b>Literal title</b>")),
            Filter(query = "notes: <b>")))
    }

    @Test fun openCodePrefixesFilterAndIconSelectOpenCodeRows() {
        val rows = fixture + fixture[0].copy(id = "opencode:ses_mock", provider = "opencode", providerLabel = "OpenCode")
        for (prefix in listOf("oc:", "opencode:", " OC : ", "OpenCode: ")) {
            assertEquals(prefix, "" to "opencode", providerQuery(prefix, "codex"))
            assertEquals(prefix, listOf("opencode:ses_mock"), ids(rows, Filter(query = prefix, archived = true)))
        }
        assertEquals("find" to "codex", providerQuery("cx: FIND", "opencode"))
        assertEquals("ocean" to "all", providerQuery("OCEAN"))
        assertEquals(listOf("opencode:ses_mock"), ids(rows, Filter(app = "opencode", archived = true)))
        assertEquals(listOf("all", "codex", "claude-desktop-code", "opencode"), APP_FILTERS.map { it.first })
        assertEquals("OpenCode", APP_FILTERS.toMap()["opencode"])
        assertEquals(R.drawable.ic_provider_openai, providerIcon("codex"))
        assertEquals(R.drawable.ic_provider_opencode, providerIcon("opencode"))
        assertEquals(R.drawable.ic_provider_claude, providerIcon("claude-desktop-code"))
        assertEquals(R.drawable.ic_provider_claude, providerIcon(""))
    }

    @Test fun pythonWhitespaceAndMultilineQueriesKeepTheirMeaning() {
        val whitespace = "\t\n\u000B\u000C\r\u001C\u001D\u001E\u001F \u0085\u00A0\u1680" +
            "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000"
        assertEquals(29, whitespace.length)
        for (space in whitespace) {
            assertEquals("find" to "all", providerQuery(space + "FIND" + space))
            assertEquals("find\nnext" to "claude-desktop-code",
                providerQuery(space + "CL" + space + ":" + space + "FIND\nNEXT" + space, "codex"))
        }
        for (notSpace in listOf('\u0000', '\u0008', '\u000E', '\u001B', '\u180E', '\u200B', '\uFEFF')) {
            assertEquals(notSpace + "find" + notSpace to "all", providerQuery(notSpace + "FIND" + notSpace))
            assertEquals(notSpace + "cl:find" to "codex", providerQuery(notSpace + "CL:FIND", "codex"))
        }
        assertEquals("find  next" to "all", providerQuery("FIND  NEXT"))
    }

    @Test fun sourceNameSearchKeepsOtherFilters() {
        val rows = listOf(
            Thread(id = "main", provider = "codex", sourceLabel = "Codex", state = "idle"),
            Thread(id = "personal", provider = "codex", sourceLabel = "ChatGPT Personal", state = "working"),
            Thread(id = "claude", provider = "claude-desktop-code", sourceLabel = "Claude Personal", state = "idle", pending = true),
            Thread(id = "archived", provider = "codex", sourceLabel = "ChatGPT Personal", state = "working", archived = true),
        )
        assertEquals(setOf("personal", "claude"), ids(rows, Filter(query = "PERSONAL")).toSet())
        assertEquals(listOf("personal"), ids(rows, Filter(query = "cx:Personal", app = "claude-desktop-code")))
        assertEquals(listOf("claude"), ids(rows, Filter(query = "cl:Personal", app = "codex")))
        assertEquals(listOf("claude"), ids(rows, Filter(query = "Personal", pendingOnly = true)))
        assertEquals(listOf("claude", "personal"),
            ids(rows, Filter(query = "Personal", states = setOf("working"), pendingOnly = true)))
        assertEquals(setOf("personal", "archived"), ids(rows, Filter(query = "Personal", app = "codex", archived = true)).toSet())
    }

    @Test fun workingPendingUnionKeepsUnreadAndOtherFilters() {
        val rows = listOf(
            Thread(id = "working-read", provider = "codex", state = "working", title = "Find work"),
            Thread(id = "working-unread", provider = "codex", state = "working", unread = true, pending = true),
            Thread(id = "idle-unread", provider = "codex", state = "idle", unread = true, title = "Find idle"),
            Thread(id = "waiting-attention", provider = "codex", state = "waiting", questionAttention = true),
            Thread(id = "unknown-unread", provider = "codex", state = "unknown", unread = true),
            Thread(id = "idle-read", provider = "codex", state = "idle"),
            Thread(id = "native-only", provider = "codex", state = "unknown", nativeUnread = true),
            Thread(id = "archived-unread", provider = "codex", state = "idle", unread = true, archived = true),
            Thread(id = "claude-unread", provider = "claude-desktop-code", state = "idle", unread = true, title = "Find Claude"),
        )
        val union = Filter(states = setOf("working"), pendingOnly = true)
        val expected = setOf("working-read", "working-unread", "idle-unread", "waiting-attention", "unknown-unread", "claude-unread")
        assertEquals(expected, ids(rows, union).toSet())
        assertEquals(expected.size, ids(rows, union).size)
        assertEquals(setOf("working-read", "working-unread"), ids(rows, Filter(states = setOf("working"))).toSet())
        assertEquals(listOf("working-unread"), ids(rows, Filter(pendingOnly = true)))
        assertEquals(listOf("working-unread"), ids(rows, union.copy(states = setOf("working", "idle"))))
        assertEquals(emptyList<String>(), ids(rows, union.copy(states = emptySet())))
        assertEquals(expected - "claude-unread", ids(rows, union.copy(app = "codex")).toSet())
        assertEquals(setOf("working-read", "idle-unread"), ids(rows, union.copy(query = "find", app = "codex")).toSet())
        assertEquals(listOf("claude-unread"), ids(rows, union.copy(query = "cl:find", app = "codex")))
        assertEquals(expected + "archived-unread", ids(rows, union.copy(archived = true)).toSet())
    }

    @Test fun sortUsesTaskStartAndStablePinAndCodePointIdOrder() {
        val rows = listOf(
            Thread(id = "work-old", state = "working", workingSinceMs = 10, updatedAtMs = 9999),
            Thread(id = "work-new", state = "working", workingSinceMs = 20, updatedAtMs = 1),
            Thread(id = "work-unknown", state = "working", workingSinceMs = -1, updatedAtMs = 99999),
            Thread(id = "wait", state = "waiting", updatedAtMs = 100),
            Thread(id = "pending-work", state = "working", pending = true, workingSinceMs = 1),
            Thread(id = "pin-b", state = "unknown", pinned = true, pinIndex = 0),
            Thread(id = "pin-a", state = "idle", pinned = true, pinIndex = 0),
            Thread(id = "pin-last", state = "idle", pinned = true, pinIndex = 1),
            Thread(id = "idle-b", state = "idle", updatedAtMs = 100),
            Thread(id = "idle-a", state = "idle", updatedAtMs = 100),
            Thread(id = "unknown", state = "unknown", updatedAtMs = 100000),
        )
        val before = rows.toList()
        assertEquals(listOf("pin-a", "pin-b", "pin-last", "pending-work", "work-new", "work-old",
            "work-unknown", "idle-a", "idle-b", "wait", "unknown"), ids(rows))
        assertEquals(before, rows)
        val supplementary = "\uD800\uDC00"
        for (pinned in listOf(false, true)) {
            val tied = listOf(supplementary, "\uE000", "a", "aa").map {
                Thread(id = it, state = "idle", pinned = pinned, pinIndex = 0)
            }
            assertEquals(listOf("a", "aa", "\uE000", supplementary), ids(tied))
        }
    }

    @Test fun readWaitingRowSortsWithTheIdleRows() {
        val rows = listOf(
            Thread(id = "done", state = "idle", pending = true, updatedAtMs = 500),
            Thread(id = "asks", state = "waiting", pending = true, questionAttention = true, updatedAtMs = 400),
            Thread(id = "approve", state = "waiting", pending = true, actionRequired = true, updatedAtMs = 300),
            Thread(id = "work", state = "working", workingSinceMs = 100, updatedAtMs = 900),
            Thread(id = "read", state = "waiting", pending = false, updatedAtMs = 800),
            Thread(id = "old", state = "idle", pending = false, updatedAtMs = 200),
        )
        assertEquals(listOf("done", "asks", "approve", "work", "read", "old"), ids(rows))
    }

    @Test fun attentionUsesOnlyTheCurrentAsbFlagsInPriorityOrder() {
        val base = Thread(state = "working", discardResult = true)
        for ((row, expected) in listOf(
            Thread() to "", Thread(unread = true) to "dot", Thread(questionAttention = true) to "question",
            Thread(unread = true, questionAttention = true) to "question",
            Thread(state = "working", manualUnread = true, nativeAttention = true, retainedUnread = true) to "",
            base to "discard", base.copy(unread = true) to "dot", base.copy(questionAttention = true) to "question",
            base.copy(actionRequired = true) to "question", base.copy(state = "idle", lastOutcome = "stopped") to "stop",
            base.copy(state = "idle") to "", Thread(state = "idle", lastOutcome = "stopped", unread = true) to "dot",
        )) assertEquals(row.toString(), expected, attentionIndicator(row))
    }

    @Test fun menusKeepPermissionPinDiscardAndDrawerRules() {
        for (row in listOf(Thread(unread = true), Thread(questionAttention = true), Thread(retainedUnread = true, unread = true))) {
            assertEquals(MenuAction("Read", "mark-read"), rowMenuActions(row).first())
        }
        assertEquals(MenuAction("Unread", "mark-unread"), rowMenuActions(Thread(nativeUnread = true, nativeAttention = false)).first())
        assertEquals(listOf("mark-unread", "unpin", "pin-up", "pin-down"),
            rowMenuActions(Thread(pinned = true)).map { it.action })
        // A required action has Read while it is unread (an older engine sends no read mark), and Unread after Read.
        val permission = Thread(state = "waiting", actionRequired = true)
        assertEquals(listOf("mark-read", "pin"), rowMenuActions(permission).map { it.action })
        assertEquals(listOf("mark-read", "pin"), rowMenuActions(permission.copy(actionAttention = true)).map { it.action })
        val read = permission.copy(actionAttention = false)
        assertEquals(listOf("mark-unread", "pin"), rowMenuActions(read).map { it.action })
        assertEquals(listOf("mark-unread", "unpin", "pin-up", "pin-down"), rowMenuActions(read.copy(pinned = true)).map { it.action })
        assertEquals(MenuAction("Read", "mark-read"), rowMenuActions(read.copy(unread = true)).first())
        assertEquals(MenuAction("Read", "mark-read"), rowMenuActions(read.copy(drawer = true)).first())
        assertTrue(actionNeedsAttention(permission))
        assertFalse(actionNeedsAttention(read))
        assertFalse(actionNeedsAttention(Thread(actionAttention = null)))
        assertEquals(MenuAction("Unread", "mark-unread"), rowMenuActions(Thread(state = "idle", lastOutcome = "stopped")).first())
        assertEquals(MenuAction("Keep result", "keep-result"), rowMenuActions(Thread(state = "working", discardResult = true)).last())
        assertEquals(MenuAction("Discard result", "discard-result"), rowMenuActions(Thread(state = "working")).last())
        assertFalse(rowMenuActions(Thread(state = "idle")).any { it.action in setOf("discard-result", "keep-result") })
        assertFalse(rowMenuActions(Thread(canOpen = true)).any { it.action == "open" })
    }

    @Test fun drawerFilterIndicatorAndMenuMatchDesktop() {
        val base = Thread(provider = "codex", state = "idle", title = "Chat", providerLabel = "Codex", canOpen = true)
        val unread = base.copy(id = "unread", unread = true, pending = true, updatedAtMs = 4)
        val tucked = base.copy(id = "tucked", drawer = true, completionAttention = true, updatedAtMs = 3)
        val rows = listOf(unread, tucked, tucked.copy(id = "claude", provider = "claude-desktop-code", title = "Find"),
            tucked.copy(id = "old", archived = true), base.copy(id = "read", updatedAtMs = 1))
        val drawer = Filter(drawerOnly = true)
        assertEquals(listOf("unread", "claude", "tucked", "read"), ids(rows))
        assertEquals(listOf("claude", "tucked"), ids(rows, drawer))
        assertEquals(listOf("claude", "old", "tucked"), ids(rows, drawer.copy(archived = true)))
        assertEquals(listOf("claude"), ids(rows, drawer.copy(query = "find")))
        assertEquals(listOf("tucked"), ids(rows, drawer.copy(app = "codex")))
        assertEquals(listOf("claude"), ids(rows, drawer.copy(query = "cl:", app = "codex")))
        assertEquals(emptyList<String>(), ids(rows, drawer.copy(states = setOf("working"))))
        for ((row, expected) in listOf(
            tucked to "dot", tucked.copy(questionAttention = true) to "question",
            tucked.copy(actionRequired = true) to "question", tucked.copy(state = "working") to "",
            tucked.copy(state = "working", discardResult = true) to "discard",
            tucked.copy(lastOutcome = "stopped") to "dot", unread to "dot", base to "",
        )) assertEquals(expected, attentionIndicator(row, drawer = true))
        assertEquals("", attentionIndicator(tucked))
        assertEquals("stop", attentionIndicator(tucked.copy(lastOutcome = "stopped")))
        assertEquals(listOf("mark-read", "drawer-in", "pin"), rowMenuActions(unread).map { it.action })
        assertEquals(listOf("mark-read", "drawer-out", "pin"), rowMenuActions(tucked).map { it.action })
        assertEquals(listOf("mark-read", "drawer-out", "pin", "discard-result"),
            rowMenuActions(tucked.copy(state = "working")).map { it.action })
        assertEquals(listOf("mark-read", "drawer-out", "pin"), rowMenuActions(tucked.copy(actionRequired = true)).map { it.action })
        for (row in listOf(base, base.copy(questionAttention = true), unread.copy(questionAttention = true),
            unread.copy(actionRequired = true))) assertFalse(rowMenuActions(row).any { it.action.startsWith("drawer-") })
    }

    @Test fun pinMoveTargetsTheVisiblePinnedNeighborAndEscapesItsId() {
        val rows = listOf(Thread(id = "a", pinned = true), Thread(id = "b", pinned = true), Thread(id = "c"))
        assertNull(pinMoveBody(rows, "a", "up"))
        assertNull(pinMoveBody(rows, "b", "down"))
        assertNull(pinMoveBody(rows, "c", "up"))
        assertNull(pinMoveBody(rows, "missing", "down"))
        assertEquals("""{"targetId":"a","placement":"before"}""", pinMoveBody(rows, "b", "up"))
        assertEquals("""{"targetId":"b","placement":"after"}""", pinMoveBody(rows, "a", "down"))
        val escaped = "quote\"slash\\newline\n"
        val body = pinMoveBody(listOf(rows[0], Thread(id = escaped, pinned = true)), "a", "down")!!
        assertEquals(escaped, Json.parseToJsonElement(body).jsonObject.getValue("targetId").jsonPrimitive.content)
    }

    @Test fun unicodeFoldingPreservesExpansionsDotsSigmaCherokeeAndNormalization() {
        for ((input, expected) in listOf(
            "Straße STRASSE ẞ" to "strasse strasse ss", "I i ı İ" to "i i ı i\u0307",
            "Σ σ ς ΟΣ" to "σ σ σ οσ", "\u13A0\uAB70\u13F8" to "\u13A0\u13A0\u13F0",
            "ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ" to "ff fi fl ffi ffl st st", "é e\u0301" to "é e\u0301",
            "\uD801\uDD70" to "\uD801\uDD97",
        )) assertEquals(expected, casefold(input))
        assertEquals(listOf("unicode"), ids(listOf(Thread(id = "unicode", state = "idle", title = "Straße")),
            Filter(query = "STRASSE")))
        assertEquals(listOf("unicode"), ids(listOf(Thread(id = "unicode", state = "idle", title = "İ")),
            Filter(query = "i")))
        assertEquals(emptyList<String>(), ids(listOf(Thread(id = "unicode", state = "idle", title = "I")),
            Filter(query = "İ")))
        assertEquals(emptyList<String>(), ids(listOf(Thread(id = "unicode", state = "idle", title = "ı")),
            Filter(query = "I")))
        assertEquals(emptyList<String>(), ids(listOf(Thread(id = "unicode", state = "idle", title = "é")),
            Filter(query = "e\u0301")))
    }

    @Test fun everyCodePointMatchesThePythonUnicode151Baseline() {
        // Generated independently with Python 3.13.5 chr(cp).casefold() for every code point.
        val digest = MessageDigest.getInstance("SHA-256")
        var changed = 0
        for (codePoint in 0..0x10FFFF) {
            val original = String(Character.toChars(codePoint))
            val folded = casefold(original)
            if (folded != original) {
                changed++
                digest.update("$codePoint=$folded\n".toByteArray(Charsets.UTF_8))
            }
        }
        assertEquals(1530, changed)
        assertEquals("50ce3332f4a0e7751952ce4e9ea9e25255d963b068484ef5e911a6af603064b9",
            digest.digest().joinToString("") { "%02x".format(it) })
    }

    @Test fun usageLimitRoundsUpUntilTheExactResetWithoutOverflow() {
        for ((milliseconds, seconds) in listOf(3_600_000L to 3600L, 3_599_000L to 3599L,
            16_330_000L to 16330L, 3_661_000L to 3661L, 60_000L to 60L, 59_000L to 59L,
            1000L to 1L, 200L to 1L, 1L to 1L)) {
            assertEquals(seconds, limitLeft(Thread(limitResetsAtMs = now + milliseconds), now))
        }
        for (reset in listOf(now, now - 1, 0L, Long.MIN_VALUE)) {
            assertEquals(0L, limitLeft(Thread(limitResetsAtMs = reset), now))
        }
        assertEquals(0L, limitLeft(Thread(state = "idle"), now))
        assertEquals(1L, limitLeft(Thread(limitResetsAtMs = Long.MAX_VALUE), Long.MAX_VALUE - 1))
        assertEquals(9_223_372_036_854_776L, limitLeft(Thread(limitResetsAtMs = Long.MAX_VALUE), 0))
        assertEquals(18_446_744_073_709_552L, limitLeft(Thread(limitResetsAtMs = Long.MAX_VALUE), Long.MIN_VALUE))
    }

    @Test fun clockCadenceUsesWorkingOrTheLastHourOfAnyVisibleReset() {
        val row = Thread(state = "idle", limitResetsAtMs = now + 3_600_000)
        assertEquals(60L, clockInterval(emptyList(), now))
        assertEquals(60L, clockInterval(listOf(row), now - 1))
        assertEquals(2L, clockInterval(listOf(row), now))
        assertEquals(60L, clockInterval(listOf(row), now + 3_600_000))
        assertEquals(2L, clockInterval(listOf(row.copy(state = "working")), now - 1))
        assertEquals(60L, clockInterval(listOf(row.copy(state = "working", archived = true)), now - 1))
        assertEquals(2L, clockInterval(listOf(row.copy(archived = true)), now))
        assertEquals(2L, clockInterval(listOf(Thread(state = "idle"), Thread(state = "working")), now))
    }

    @Test fun limitedDrawerDotReturnsAtResetWithoutChangingOtherAttentionRules() {
        val row = Thread(id = "a", state = "idle", drawer = true, limitResetsAtMs = now + 3_600_000)
        assertEquals("", attentionIndicator(row, drawer = true, nowMs = now))
        assertEquals("dot", attentionIndicator(row, drawer = true, nowMs = now + 3_600_000))
        assertEquals("", attentionIndicator(row, nowMs = now))
        assertEquals("question", attentionIndicator(row.copy(questionAttention = true), true, now))
        assertEquals("question", attentionIndicator(row.copy(actionRequired = true), true, now))
        assertEquals("dot", attentionIndicator(row.copy(unread = true), true, now))
        assertEquals("discard", attentionIndicator(row.copy(state = "working", discardResult = true), true, now))
        assertEquals(listOf("mark-read", "drawer-out", "pin"), rowMenuActions(row).map { it.action })
    }

    @Test fun newMessagesFirstSnapshotSeenReplacementAgeVisibilityPairsAndCap() {
        val at = 1_000_000L
        val visible = setOf("a", "b", "c")
        fun message(from: String, to: String, time: Long = at - 1000) = Message(from, to, time)
        val first = message("a", "b")
        var result = newMessages(listOf(first), null, visible, at, 6)
        assertEquals(emptyList<Message>() to setOf(first), result)
        val reply = message("b", "a", at - 500)
        result = newMessages(listOf(first, reply), result.second, visible, at, 6)
        assertEquals(listOf(reply) to setOf(first, reply), result)
        result = newMessages(listOf(reply), result.second, visible, at, 6)
        assertEquals(emptyList<Message>() to setOf(reply), result)
        assertEquals(listOf(first), newMessages(listOf(first), result.second, visible, at, 6).first)
        val boundary = message("a", "c", at - 30_000)
        val old = message("a", "b", at - 30_001)
        assertEquals(listOf(boundary) to setOf(boundary, old),
            newMessages(listOf(boundary, old), emptySet(), visible, at, 6))
        val hidden = listOf(message("a", "hidden"), message("hidden", "a"), message("a", "a"))
        assertEquals(emptyList<Message>() to hidden.toSet(), newMessages(hidden, emptySet(), visible, at, 6))
        val samePair = listOf(message("a", "b", at - 3), message("a", "b", at - 2), message("b", "a", at - 1))
        assertEquals(listOf(samePair[0], samePair[2]), newMessages(samePair, emptySet(), visible, at, 6).first)
        assertEquals(listOf(samePair[1], samePair[2]), newMessages(samePair, setOf(samePair[0]), visible, at, 6).first)
        val messages = (0..7).map { message("$it", "${it + 1}") }
        val many = (0..8).map { "$it" }.toSet()
        assertEquals(6, MESSAGE_FLIGHT_LIMIT)
        assertEquals(30_000L, MESSAGE_MAX_AGE_MS)
        assertEquals(messages.take(6) to messages.toSet(), newMessages(messages, emptySet(), many, at, 6))
        assertEquals(messages.take(2) to messages.toSet(), newMessages(messages, emptySet(), many, at, 2))
        for (room in listOf(0, -1)) {
            assertEquals(emptyList<Message>() to messages.toSet(), newMessages(messages, emptySet(), many, at, room))
        }
        assertEquals(emptyList<Message>() to emptySet<Message>(), newMessages(emptyList(), emptySet(), visible, at, 6))
        val future = message("a", "b", at + 5000)
        assertEquals(listOf(future), newMessages(listOf(future), emptySet(), visible, at, 6).first)
        val ancient = message("a", "b", Long.MIN_VALUE)
        assertEquals(emptyList<Message>(), newMessages(listOf(ancient), emptySet(), visible, at, 6).first)
        assertEquals(listOf(ancient), newMessages(listOf(ancient), emptySet(), visible, Long.MIN_VALUE, 6).first)
        assertEquals(listOf(first), newMessages(listOf(first, first), emptySet(), visible, at, 6).first)
    }

    @Test fun messageDurationAndControlMatchNativeGeometry() {
        assertEquals(480.0, messageDuration(100.0), 0.0)
        assertEquals(700.0, messageDuration(1050.0), 0.0)
        assertEquals(900.0, messageDuration(3000.0), 0.0)
        assertEquals(480.0, messageDuration(-1.0), 0.0)
        assertEquals(480.0, messageDuration(Double.NaN), 0.0)
        assertEquals(900.0, messageDuration(Double.POSITIVE_INFINITY), 0.0)
        assertEquals(1001.0 / 1.5, messageDuration(1001.0), 0.0)
        assertEquals(50.0 to 78.0, messageControl(0.0 to 100.0, 100.0 to 100.0))
        assertEquals(50.0 to 78.0, messageControl(100.0 to 100.0, 0.0 to 100.0))
        assertEquals(500.0 to -60.0, messageControl(0.0 to 0.0, 1000.0 to 0.0))
        assertEquals(28.0 to 50.0, messageControl(50.0 to 0.0, 50.0 to 100.0))
        assertEquals(28.0 to 50.0, messageControl(50.0 to 100.0, 50.0 to 0.0))
        assertEquals(2.0 to 500.0, messageControl(5.0 to 0.0, 5.0 to 1000.0))
        val (x, y) = messageControl(0.0 to 0.0, 100.0 to 80.0)
        assertTrue(x > 50)
        assertTrue(y < 40)
        assertEquals(7.0 to 7.0, messageControl(7.0 to 7.0, 7.0 to 7.0))
        assertEquals(2.0 to 0.0, messageControl(0.0 to 0.0, 0.0 to 0.0))
    }

    // The cases of test_row_panel_controls_note_and_edges_follow_the_menu_rules in test/asb_native_logic_test.py.
    @Test fun rowPanelControlsAndNoteFollowTheMenuRules() {
        val idle = Thread(state = "idle", unread = true, pinned = true)
        assertEquals(mapOf("unread" to PanelControl(true, "mark-read"), "drawer" to PanelControl(false, "drawer-in"),
            "pinned" to PanelControl(true, "unpin"), "order" to PanelControl(true, "pin-up")), rowPanelControls(idle))
        assertEquals(listOf("unread", "drawer", "pinned", "order"), rowPanelControls(idle).keys.toList())
        assertEquals("Finished. Not read yet.", rowPanelNote(idle))
        assertEquals("Marked unread.", rowPanelNote(idle.copy(manualUnread = true)))
        val working = Thread(state = "working")
        assertEquals(mapOf("unread" to PanelControl(false, "mark-unread"), "drawer" to PanelControl(false, null),
            "pinned" to PanelControl(false, "pin"), "discard" to PanelControl(false, "discard-result")), rowPanelControls(working))
        assertEquals(PanelControl(true, "keep-result"), rowPanelControls(working.copy(discardResult = true))["discard"])
        assertEquals("", rowPanelNote(working.copy(unread = true)))
        val drawer = Thread(state = "idle", drawer = true)
        assertEquals(PanelControl(true, "mark-read"), rowPanelControls(drawer)["unread"])
        assertEquals(PanelControl(true, "drawer-out"), rowPanelControls(drawer)["drawer"])
        assertEquals("Finished. Not read yet.", rowPanelNote(drawer))
        val waiting = Thread(state = "waiting", actionRequired = true, questionAttention = true)
        assertEquals(PanelControl(true, "mark-read"), rowPanelControls(waiting)["unread"])
        assertEquals(PanelControl(false, "mark-unread"), rowPanelControls(waiting.copy(actionAttention = false))["unread"])
        assertEquals(PanelControl(false, null), rowPanelControls(waiting)["drawer"])
        assertEquals("Waits for your permission.", rowPanelNote(waiting))
        assertEquals("Asks a question.", rowPanelNote(Thread(state = "idle", questionAttention = true)))
        assertEquals("", rowPanelNote(Thread(state = "idle")))
        for (row in listOf(idle, working, drawer, waiting)) {
            val offered = rowMenuActions(row).map { it.action }.toSet()
            assertEquals(offered - setOf("pin-up", "pin-down"),
                rowPanelControls(row).values.mapNotNull { it.action }.toSet() - "pin-up")
        }
    }

    @Test fun panelFocusReturnsOnlyToAControlThatIsStillThereAndEnabled() {
        val idle = rowPanelControls(Thread(state = "idle", unread = true, pinned = true))
        assertEquals("unread", panelFocusReturn("unread", idle))
        assertEquals("earlier", panelFocusReturn("earlier", idle))
        assertEquals("later", panelFocusReturn("later", idle))
        assertEquals(null, panelFocusReturn(null, idle))
        // The Discard switch goes away when Working ends; the pin order goes away with the pin.
        assertEquals(null, panelFocusReturn("discard", idle))
        assertEquals(null, panelFocusReturn("later", rowPanelControls(Thread(state = "idle"))))
        val working = rowPanelControls(Thread(state = "working"))
        assertEquals("discard", panelFocusReturn("discard", working))
        // A control without an action is disabled, so it cannot take the focus.
        assertEquals(null, panelFocusReturn("drawer", working))
    }

    @Test fun keepIndexOnlyWhenKeysChangeAndNotScrolling() {
        val keys = listOf<Any>("a", "b", "c", "bottom-space")
        assertFalse(keepIndexOnChange(null, keys, false))
        assertFalse(keepIndexOnChange(keys, keys.toList(), false))
        assertTrue(keepIndexOnChange(keys, listOf("c", "a", "b", "bottom-space"), false))
        assertTrue(keepIndexOnChange(keys, listOf("warning:codex", "a", "b", "c", "bottom-space"), false))
        assertTrue(keepIndexOnChange(keys, listOf("a", "c", "bottom-space"), false))
        assertFalse(keepIndexOnChange(keys, listOf("c", "a", "b", "bottom-space"), true))
    }

    @Test fun keptPositionKeepsTheRowSlotWhenLeadingItemsChange() {
        // At the top: stay at the top, so a new warning shows.
        assertEquals(0 to 0, keptPosition(0, 0, 0, 1, 1))
        assertEquals(0 to 0, keptPosition(0, 0, 2, 0, -1))
        assertEquals(0 to 0, keptPosition(0, 0, 1, 2, 1))
        // A row first (row 3 after 1 warning): a warning added or removed keeps that row and its offset first.
        assertEquals(5 to 30, keptPosition(4, 30, 1, 2, 5))
        assertEquals(3 to 30, keptPosition(4, 30, 1, 0, 3))
        // A row first with offset at index 0 (no leading items) is not at the top.
        assertEquals(1 to 30, keptPosition(0, 30, 0, 1, 1))
        // A row first keeps its row slot after a reorder, not the row that moved.
        assertEquals(4 to 0, keptPosition(4, 0, 2, 2, 6))
        // The "empty" item first: rows come, so the first row shows.
        assertEquals(1 to 0, keptPosition(1, 16, 2, 1, -1))
        // A warning first keeps its index and offset when the rows reorder.
        assertEquals(0 to 60, keptPosition(0, 60, 1, 1, 0))
        assertEquals(1 to 30, keptPosition(1, 30, 3, 3, 1))
        // A warning first follows its key when warnings before it clear or a new one comes above it.
        assertEquals(0 to 20, keptPosition(1, 20, 2, 1, 0))
        assertEquals(0 to 20, keptPosition(2, 20, 3, 1, 0))
        assertEquals(1 to 30, keptPosition(0, 30, 1, 2, 1))
        // The first warning clears: the item now at its index, at most the first row, shows in full.
        assertEquals(0 to 0, keptPosition(0, 40, 2, 1, -1))
        assertEquals(1 to 0, keptPosition(1, 20, 3, 2, -1))
        assertEquals(1 to 0, keptPosition(2, 20, 3, 1, -1))
    }

    @Test fun startIndexFindsTheAnchorRow() {
        val ids = listOf("a", "b", "c", "d", "e", "f")
        // "" (a list at the top) and a missing id give -1: the top.
        assertEquals(0, startIndex(ids.indexOf(""), flow = false, capacity = 1, lead = 2))
        assertEquals(0, startIndex(ids.indexOf("gone"), flow = true, capacity = 4, lead = 0))
        // Flow with capacity 4: row 5 is in column 1.
        assertEquals(0, startIndex(ids.indexOf("a"), flow = true, capacity = 4, lead = 0))
        assertEquals(1, startIndex(ids.indexOf("f"), flow = true, capacity = 4, lead = 0))
        // Portrait with 2 warnings: row 2 is item 4.
        assertEquals(4, startIndex(ids.indexOf("c"), flow = false, capacity = 4, lead = 2))
        assertEquals(2, startIndex(ids.indexOf("a"), flow = false, capacity = 4, lead = 2))
    }
}
