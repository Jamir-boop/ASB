---
name: ASB
description: Native dark session switcher for GNOME
typography:
  body:
    fontSize: "13px"
  label:
    fontSize: "11px"
rounded:
  session: "3px"
  unread-dot: "50%"
spacing:
  row-gap: "6px"
  row-inset: "5px"
  frame-inset: "4px"
  column-gap: "12px"
components:
  session-row:
    typography: "{typography.body}"
    rounded: "{rounded.session}"
    padding: "0"
  session-state:
    typography: "{typography.label}"
  provider-mark:
    size: "14px"
  unread-dot:
    rounded: "{rounded.unread-dot}"
---

# Design System: ASB

## Overview

**Creative North Star: "Column Flow"**

ASB is a native GNOME session index. The user approved Column Flow and the Workspace-first Comfortable option. Compact keeps one line per session; Comfortable puts the folder above a two-line title. Both use the available window area for rows and columns.

The title and text state carry the main information. Provider marks stay subdued. Attention has a clear label and, when unread, a small dot.

**Key Characteristics:**

- Native GTK4 and Libadwaita controls.
- Dark mode only within ASB.
- Compact 22px rows and Workspace-first Comfortable 68px rows.
- Down each column, then across.
- Text labels for state and attention.

## Colors

GNOME colors are semantic system roles. Custom colors are user values. Neither is a fixed ASB palette, so the frontmatter has no fixed color primitives.

### Primary

Use GNOME `accent_color` for Pending text and unread dots. Working uses the GTK `success` style. Waiting uses `warning`. The current GNOME accent can be yellow; do not make that machine setting a permanent product rule.

### Neutral

Use the current GNOME window background and foreground. Inherit dim text, hover, focus, and control surfaces from GTK. Columns use the GNOME `borders` role for their divider. Provider marks use the foreground with reduced opacity (0.65).

### Custom colors

The saved fields are `background`, `text`, `accent`, `muted`, and `divider`. Each is a six-digit `#RRGGBB` value. The background must have relative luminance at or below 0.12. Text, muted text, and accent must each have contrast of at least 4.5:1 against both the background and row highlight. Divider color has no minimum contrast.

The highlight mixes the background (85%) and accent (15%) in encoded RGB, with each channel rounded. Custom Working, Waiting, and Pending labels use the accent. Their text labels keep the states distinct. Validation errors retain the applied theme and saved file.

A user color change selects Custom colors. Apply checks, applies, and saves the palette with visible success or error text. Loading saved colors and resetting the pickers do not change the selected mode. Reset removes the saved palette and selects GNOME colors. Save errors keep the previous palette.

**The Local Theme Rule.** Apply colors only to ASB. Never change GNOME settings to match a preview.

## Typography

Inherit the current GTK font family and control typography. Do not add a font or record the current machine's font as a requirement. The frontmatter records only ASB's explicit row and state sizes. Control and caption styles remain native.

Compact keeps the title on one line. Comfortable wraps the title to two lines in a fixed 32px block. Both ellipsize at the end and use the same native font family and 13px title size. The tooltip carries the full title and folder. The title from the server has at most 300 characters; a longer stored title ends with `…`, and whole Unicode code points are kept. Rows, tooltips, and search use this limited title.

## Layout

Column Flow uses equal-width native lists with a vertical divider between columns. Use the frontmatter spacing tokens for frame margins and columns. All real columns are in one horizontal native box, with no stacked pages or trailing empty columns.

Rows use a nominal 22px in Compact and 68px in Comfortable. These are minimum heights, and they are the real heights with the reference font, Cascadia Code NF 11. A font with higher lines makes rows higher, and a two-line title can make one row higher than the others. Packing uses the viewport of the scroll area, not the whole window and not the scrolled window: a horizontal scrollbar that is not an overlay takes height from the viewport. `columns = max(1, floor((width + 12) / (column_width + 12)))` and `capacity = max(1, floor((height - 4) / row_height))`, where `width` and `height` are the viewport size and `row_height` is the height of the highest visible row after layout. Before the rows have a layout, and at a view change, `row_height` is the nominal value. When the measured value is different, the window repacks one time. The shared target width defaults to 240px and accepts 160–600px. A 360px window has one default column or two at 160px. Fill down a column, then move across. Create only the needed columns and continue left to right. The horizontal scrollbar is automatic; vertical scrolling is disabled. Ordinary wheel movement maps to the horizontal adjustment; trackpad X and Shift-wheel work too. Keep the visible-column width logic and equal widths across the full strip. Columns keep the shared width when the list has fewer columns than the window can show, for example search results; long titles must not make a column wider.

Use one critically damped Libadwaita spring toward the target for wheel scrolling in both views. The damping ratio is 1 and the velocity is continuous. The spring settles in about 350 ms with no overshoot. A new wheel event keeps the current speed, limited so that the scroll never passes its clamped target. A move of less than half a pixel is immediate. Do not restart an ease-out for each wheel event. Keep the step per click. Same-direction input adds to the clamped target; reversal starts from the current visible position. Surface/trackpad input stays direct and cancels the wheel animation. GNOME animations off gives immediate wheel feedback. Bounds, layout, filters, view changes, scrollbar or focus scroll changes, unmap, and close cancel old targets. Unchanged refresh keeps active scroll. Add no permanent frame loop or source reads on animation frames.

The native mock captures show one, two, and four default columns at window widths of 360, 680, and 1040 pixels. A 1080×248 window shows four default columns or six at 160px, with three complete Comfortable rows per column. These are checked sizes, not fixed column-count breakpoints. The default window is 420 by 900 pixels.

Use one `Gtk.WindowHandle` toolbar with search, a 16px disc app mark, settings, refresh, and native close. Codex, Claude, Pending, Working, and Drawer are native toggle pills in both views, in that order. The Drawer pill has the drawer glyph, the word "Drawer", and an accent count bubble. The count is the number of drawer rows that the archive setting allows: archived rows count only while "Show archived sessions" is on. Search, the app pills, and the state filters do not change it. The bubble is hidden at zero and shows `99+` from 100. The checked pill has the accent color as background and an inverted bubble (background color with accent text). The tooltip is "Show only the sessions in the drawer, as unread. Point here to see them in the list." The accessible label is "Drawer only. Sessions in the drawer: N". Place pills and counts in that row at 680px or wider, and in the existing second short row below it at smaller widths. Keep the pills usable at 320px. In a narrow window the word "Drawer" can ellipsize and the count text can shrink to no width. The count text starts with the Pending number ("N Pending · M sessions"). Thus the default 420px window, which cuts the end of the text with five pills, still shows the Pending count. There is no separate title row or instructional footer. Keep native move, resize, and close behavior. Settings opens the separate Preferences window; list repacking does not rebuild its controls or take their focus. Do not change the app's outer border.

**The Whole Session Rule.** Keep provider, title, state, and attention within one activatable row. Compact uses one line; Comfortable uses one 68px Workspace-first row.

## Elevation & Depth

The session area is flat. It adds no row shadows or card surfaces. Dividers separate columns. GTK owns the toolbar, Preferences window, row-menu popover, dialog, and focus depth. Compact keeps static hover; keyboard focus keeps its existing native or custom highlight.

Comfortable paints one rounded hover highlight behind the cards and their actions, including across columns. One native animation moves it in 200 ms with exponential ease-out and fades arrival/leave in 100 ms, aligned with the approved command-palette motion reference. From hidden, it appears at the new card. A rapid pointer change starts from the current painted bounds. The paint takes no pointer input and cannot change card size or position. Use the current GNOME foreground at 7% opacity, or the existing custom highlight mix. With GNOME animations off, the highlight changes immediately. Clear it on repack, filters, resize, scroll, the start of a card motion, unmap, and close. During scroll, clear shared paint once and suppress hover restarts while the wheel spring is active. After scroll, ignore stationary or generated pointer motion. Real pointer movement restores the glide. Static row hover and keyboard focus remain while shared paint is absent. Keep keyboard focus and button feedback separate. Add no permanent animation loop.

Card motion applies to both views. When data or filters change the order or the set of visible cards, each card that stays visible glides from its old place to its new place, and each new card fades in. A card that leaves disappears at once. The causes are a row that goes from unread to read, a new order from a refresh, a pin move, search text, the pills, the Preferences filters, and the archive setting. List changes from the drawer use this same motion; add no new timer and no frame loop for the drawer. Use one shared animation of about 350 ms with a critically damped spring feel for all cards. A new change during the animation starts from the current painted places. Use no motion at the first render, when the window is not mapped, when GNOME animations are off, or when the packing dimensions change (window size, column width, view). The motion is paint only: allocation, input, focus, and accessibility are at the final layout at all times. Invalidate a column on each frame only when its motion bounds intersect the viewport. The final clear must also clear cached paint outside the viewport. Clear the shared hover highlight when a motion starts. Add no permanent frame loop.

## Shapes

Use the frontmatter session radius. The unread dot has minimum width and height (7px) and a round shape. A passive stop square uses the same 7px size and position, with a 1px radius and the GNOME muted foreground or custom muted role. Keep native shapes for buttons, entries, switches, dropdowns, color dialogs, and popovers.

The approved A Hollow dot for Discard has a 9px outer size: 6px empty space plus a 1.5px circular border. Armed uses GNOME foreground or custom text; the unarmed Comfortable offer uses a dashed muted border. It is never an accent unread dot.

The drawer glyph is in the same family of marks. Draw it with styled boxes, as the dot, the Discard ring, and the stop square are: a small rounded rectangle outline with a short handle line. Add no icon file. A row in the drawer shows the filled glyph in the accent color on its drawer button.

## Components

### Preferences

The user approved Option B: one separate, nonmodal native Preferences window. The toolbar settings button raises the retained window. Closing Preferences hides it, keeps ASB running, and keeps the selected section and form edits. Main-window shutdown destroys it. Use native window and control surfaces, with the same GNOME or custom theme as the main window.

Use a `Gtk.StackSidebar` on the left at wide widths. An `Adw.Breakpoint` at `max-width:600px` replaces it with `Gtk.StackSwitcher` tabs above the content. The sections are **Sessions**, **Appearance**, and **Profiles**. Sessions holds app/state/archive filters and Persistent unread. Appearance holds View, shared Column width and Reset width, GNOME/Custom colors, the five color pickers, Apply theme, and Reset to GNOME. Keep page content scrollable when height is small.

Profiles embeds the existing source table and editor. Create and load it only on its first selection; section changes and reopening do not reload it. Explicit source actions keep their existing load behavior. Keep form edits across section changes. Add no timer, background source scan, dependency, or backend route. Keep main cards, borders, and scrolling unchanged.

### Session row

Use the same `Gtk.ListBoxRow`, accessible name, tooltip, focus/menu, pin drag, and open behavior in both views. Compact keeps the existing gray provider mark, title, dot, and state on one line. Comfortable uses a vertical box: provider plus folder basename above the two-line title, then state left and relative age right. The approved C Corner pair puts the Read dot beside the top-right pin. The approved drawer design makes the corner a row of three: drawer, read, pin. Full folder remains on hover. Ellipsize folder and age when space is short; preserve full state and the action pair at 160px. Keep padding on row content. Click or Enter opens a valid link; missing links disable activation.

The approved C Restore on hover text rule applies only to Comfortable Idle rows without `unread`, `questionAttention`, or `pending`. Quiet title, folder, state, and age restore normal roles on hover or focus within. Pinned Idle-read rows also use quiet text; provider marks and pin/Read controls keep their existing strength. Source unread or unknown read status does not override an ASB acknowledgment. Mix the active text roles toward their background, with a 4.5:1 floor on background and highlight. A custom role near the floor can retain its original color. Set quiet label opacity to 1 to avoid another dim-label reduction; never dim the whole row. Compact, card dimensions, and controls stay unchanged.

The hover rule applies to both views. While the pointer is on an unread row, it looks read: do not show the unread dot, and give the state label the read tone. When the pointer leaves, it looks unread again. In Comfortable, the Read slot shows its check cue while the pointer is on the card. A `?`, the stop square, and the Discard ring do not change on hover. The read look (no dot, and the check cue in Comfortable) also shows while the row has visible keyboard focus or while one of its controls has visible keyboard focus. Focus that comes from a mouse click does not change the row: its dot stays. In Compact, focus never hides the dot.

Comfortable uses three circular controls with a minimum size of 24×24px and a 2px gap, in the order drawer, read, pin. They sit in a `Gtk.Overlay` with measurement disabled. Folder and title reserve 54px inside the existing 8px right inset, for 62px total. The fixed title block, 68px row, state/time footer, and outer frame stay unchanged. The pin appears on row hover or keyboard focus. A pinned control stays visible with a quiet foreground tint. The Read target stays visible while attention is present; hover/focus shows a check cue. A drawer row outside the drawer view hides its Read target until the pointer or visible focus is on the row. Use GNOME accent for Read and `success_color` for confirmation. Custom mode uses the saved accent for both.

The drawer button shows only while the pointer is on the card, while the card has visible keyboard focus, or while the button itself has visible keyboard focus. Focus that comes from a mouse click does not show it. Show it for a row that looks unread (**Put in drawer**) and for a row in the drawer (**Take out of drawer**, filled glyph in the accent color). The title keeps its width and the text reserve does not change: the three controls lie over the end of the first title line, with a 16px fade to the window background, not to the hover color. On a highlighted row this gives a slightly darker pocket behind the buttons. A column narrower than 190px has no drawer button; the row menu has the actions there. Compact has no card buttons.

Pin/Unpin and Read use the existing ASB actions. The controls cannot open the row or start a pin drag. A row with a card action in flight ignores activation, so a real pointer click on a card button does not also open the session. Space or Enter activates the focused control. A successful Read shows a check for 1.6 seconds; failure keeps the dot and adds the error to the row tooltip. Read clears ASB attention with either Persistent unread setting. It does not change execution, source read state, or source question resolution. Row identity, view, feedback generation, and attention guards reject stale results and clear feedback when new unread appears.

While an action is pending, controls remain pointer-sensitive to retain native gesture handling, but have no action binding. Accessible `BUSY` and `DISABLED` states describe this condition. The confirmed Read control has no action binding and reports `DISABLED`. Keep these controls separate from row opening. The real pin order, row menu, drag reorder, and keyboard pin movement remain available.

After a completed successful Read, ignore Discard/Keep activation for 0.5 seconds using the row's monotonic timestamp. Keep the ring/offer visible immediately. Apply the guard before busy state or requests; do not change menu entries, server behavior, or Idle/Waiting Read confirmation. Clear the stored timestamp on row release.

Sort ASB-owned pins first in saved order. Sort unpinned Pending and Waiting attention next, then Working, Idle, and Unknown. A Working row sorts by the start of its current task (`workingSinceMs`), not by its last activity, so it does not move while it works. A Working row with no known start sorts after the Working rows that have one, by ID. In the Pending group, Working rows (a question on a Working chat) come first, by task start, and the other Pending rows follow by newest activity. A row moves when its state or group changes or a new task starts. In the other cases, use newest activity first and ID as the tie-break. Do not import original-app pins. Always show the actual Working, Waiting, Idle, or Unknown label in the same row as the dot. Pending is attention only. Reading a dot cannot change that state label. A drawer row is not Pending and sorts with the read rows.

A row has one indicator with priority `?`, dot, Discard ring, stop. Question attention or a current permission wait shows a `?` glyph (11px, heavy weight, accent color) in the dot position. Unread shows the dot. Armed Working shows the hollow ring. An Idle stopped outcome shows the muted square when there is no attention. Every visible unread dot or `?` counts as Pending; a Discard ring or stop square does not. A Working row is never unread: it shows no unread dot, and only a `?` can make it join Pending-only. Stored marks show again when Working ends. A permission wait stays Waiting and Pending until resolved, including pending Claude `ExitPlanMode` and fresh remote `requires_action`. Its `?` and the stop square have no Read binding or hover check cue. Existing pin geometry and the 24px indicator target stay unchanged. New work or a later end removes the stop square.

A drawer row looks read outside the drawer view: no unread dot, no Pending, and the read text rule. In the drawer view it looks unread as normal. Only a row with an unread dot can go in the drawer; a `?`, a required action in the original app, or a Working state cannot. The drawer has no time limit. The row comes out as normal unread and Pending when ASB sees a result or failure time that is newer than `drawerSeen`, or when the chat has a question. This includes a task that ASB did not see in its Working phase, for example a short task between two scans. A native unread that is raised again in the original app with no new result does not take the row out. When no stored mark is left, for example the chat was read in the original app and ASB has no other mark for it, the row leaves the drawer as a read chat. An unknown native read state for a time keeps the row in the drawer. A drawer row that goes Working stays in the drawer. A stopped task keeps the row in the drawer. A task that ends with Discard result on acknowledges the completion and native marks, as in 1.5.0. A drawer row whose only mark is of that kind is then read and leaves the drawer. A drawer row with a manual Unread mark stays in the drawer and is not Pending.

In Comfortable, reuse the Read slot for Discard when Working has no visible question. An unarmed, focusable 24px control stays at zero opacity until row hover/focus reveals its dashed ring. Its action is **Discard result**. Armed, the solid ring stays visible with **Keep result**. The tooltips are **Discard result: go to read Idle when this task ends** and **Keep result: show the dot when this task ends**. Accessible control names include the title; armed rows say **Discard is on.** Discard has no Read hover check or action confirmation. Questions keep the real Read action or passive wait. Reading a Working question returns directly to the Discard ring, with no check; new Working without a question cancels old Read feedback. Idle/Waiting Read confirmation stays unchanged. Busy controls retain pointer guards and have no action binding. Keep pin geometry, borders, 22px/68px row sizes, and text strength. Compact shows a passive armed ring and retains its timer; its row menu sets Discard.

ASB acknowledgment can suppress the local dot while retaining original read truth. A new Read-to-Unread episode, completion, or terminal failure can add attention again. Failure requires an observed Working-to-Idle end when native read truth is unknown; no new failure dot appears for a historical first load. The last linked group end decides the outcome, while active work hides unread. Tooltips and accessible names distinguish the current wait, stopped task, failed task, and completed task. Opening replaces only the title label with **Opening…**. Refresh and resize retain that inline state until the open finishes. Then restore the current title. Open failures stay in the row tooltip and accessible description. Do not add per-open global banners.

### Focus and row menu

Use native focus. In custom mode, use accent for the focus outline and the entry's inset focus border (1px). Keep the row highlight behind hovered or focused rows. Up and Down move one sorted row; Left and Right move one column capacity. Home and End select the first and last row. Preserve the focused ID and clamped horizontal position. A normal refresh keeps user position; keyboard movement, mode changes, and resize reveal the focused row when needed.

At start, give no widget the keyboard focus; a focused search field has a blinking cursor that repaints the window. The first Tab goes to the search field. Printable typing from a row or another non-editable area moves focus to search and enters the character. Search has no fixed delay. Escape clears the query and provider prefix while preserving explicit filters. A queued row focus restore must stop if focus changes before it runs. Keep Ctrl/Alt/Super shortcuts, editable fields, popup typeahead, and Space/Enter control activation native. Escape closes an open native popup before clearing search.

Right-click, Menu, or Shift+F10 opens the native row menu. A row with an ASB dot or question attention offers **Read**; a row without either offers **Unread**. A current permission wait has no Read action, even with another unread mark. A stopped row can still be marked Unread. In both views, a row that looks unread also offers **Put in drawer**, and a row in the drawer offers **Take out of drawer** with **Read**, and no **Unread**. The menu keeps **Pin**/**Unpin** and keyboard pin movement. Defer popup unparent until GTK finishes menu activation so window actions retain their ancestry. Keep the accessible row name's title, provider, state, manual mark, ASB pin, question/wait cue, and terminal outcome.

Working rows also offer **Discard result** or **Keep result**. These actions use the same local session API as Read and Pin, with no row-open behavior. Discard is a one-shot task mark, not attention or sorting. Waiting/Unknown retain it, observed Idle clears it, and explicit new-task evidence prevents an old arm from carrying into the next local task. Manual, question, and failed-task attention remain available.

Pinned rows have native `Gtk.DragSource`/`Gtk.DropTarget` reorder. Accept only an active drag from an ASB pin onto another known ASB pin. Dropping above/below the row midpoint places it before/after. Keep the full global order when some rows are filtered out. **Move pin earlier/later** is the keyboard fallback. It moves the pin before or after the adjacent visible pinned row, with search and filters applied. It sends nothing at the first or last visible pin. Add no separate pin bar or project headers.

### Tooltip

Use the approved A Unfolded card in both views. Keep the native GTK tooltip background, border, radius, and font family. The content follows the card order and has no title/path truncation or fixed height.

The first line has the row's 14px provider icon and full folder path in muted 11px text, with WORD_CHAR wrapping. Replace the home prefix with `~` only at a directory boundary. No folder uses the project name or **No project folder**. Put the full 13px title below it, indented 21px and wrapped with no line limit.

The 11px footer has **State · time** in the row's state color. Known Working starts use the current duration; other cases use relative age once. The muted app label is right aligned, with the source label added only when it differs. A native FlowBox puts the app on its own right-aligned line when needed. Labels use an approximate 36-character wrap width. Show the existing Soft profile dot before the app only when its validated color/count/visibility rule shows the row dot.

Add a 21px-indented note block and one native hairline only when a note, flag, or row error exists. Its 12px line uses one shape from the row's actual indicator and one fixed sentence. Permission wait takes priority over simultaneous question attention. Dot wording follows the current attention source, keeping manual, native, observed completion/failure, and retained attention distinct. A read historical failure has no failed-unread note. A drawer row keeps its normal unread note; the note text does not name the drawer. A Working drawer row has the flag and no note. A still-open question with acknowledged attention has no shape and muted text. Flags are only **Pinned**, **Archived**, **In the drawer**, and **No direct link**, joined with ` · ` in muted 11px text. Keep the current row error below them.

Compute a fresh cheap model on `query-tooltip` without a source read. Lazily cache one plain-text GTK content widget and its complete render key on the row. Reuse unchanged content and call `set_custom` on every query. Rebuild for changed model, provider/state tint, or custom-theme flag. Palette changes invalidate every cached row, including hidden rows. Connect one query handler per cached row; release/close clears content/key and disconnects the handler separately from the five input controllers. Let GTK manage parenting. Do not set a static row tooltip string. Control tooltips stay unchanged. Visible content omits state reason, unknown-read text, source IDs/color metadata, and long pin instructions. The accessible description keeps the full original path, title, state/time, note, flags, error, state reason, and source name/ID. The accessible row name stays unchanged, except that the label of a drawer row ends with "In the drawer. Still unread."

### Provider Soft dot

Use the approved Soft dot at the lower-left of the existing Codex or Claude provider icon. Its solid fill is 6px, with a 1px background rim and an 8px outer size. Put it in a `Gtk.Overlay` with measurement and pointer targeting disabled. Show it only when `sourceCount > 1` for that provider, including disabled registered sources, and `sourceShowMarker` is true or omitted. Hide it for legacy and single-source rows. Profile numbers remain metadata and are not visible.

Use read-only `sourceColor` as the configured fill and the current background for the rim. The display can mix the fill toward white to keep 3:1 contrast on the current base and hover backgrounds. This does not change the saved color. State and unread colors stay unchanged. Keep provider marks, row/card size, border, pin/Read controls, controllers, and theme controls unchanged. The source name and ID remain in tooltips and accessible descriptions. Search includes `sourceLabel`, so color is not the only source identifier. Source IDs define identity; matching colors do not merge rows. Keep the existing provider pills.

| Muted preset | Color |
| --- | --- |
| Slate blue | `#8296b4` |
| Clay | `#b28f80` |
| Plum | `#a28caa` |
| Sage | `#899e91` |

### App sources

Place the source table and one editor in **Profiles** in Preferences. Table columns are Enabled, Name / App, Session folder, Open with, and Chats / Status. Use native controls and path pickers for the app, name, data folder, installed launcher, optional Claude transcript folder, and enabled flag. Add one native **Profile color** picker and the four muted presets above. Save optional `source.color` as lowercase `#RRGGBB` through the existing API, including dark colors. Apply the 3:1 contrast floor to the displayed dot, not the saved color. The native **Show profile dot** checkbox saves optional `source.showMarker`; false hides only the passive row dot and keeps its saved color. Old records get a stable ID-based color and show the dot; edits without either field retain its existing value. Keep Add, Save, Remove, Cancel, and Refresh in this section. Show **Saved** after a successful save and keep form input on an error.

Default sources permit edits and disable but no removal or provider change. Additional sources need a supported installed launcher. Show validation and read errors in Profiles. Source settings use the shared authenticated API; they do not change the main row layout or add a source filter pill. Saved attention, pins, unread marks, and other settings remain when a source is disabled or removed. The earlier App sources window has no recorded native visual check.

### Search and filters

Use native `Gtk.SearchEntry`, `Gtk.DropDown`, `Gtk.CheckButton`, and toggle pills. Codex/Claude pills and the App field in Sessions use one selected-app set. No selection and both providers show all; one selects it. Working alone selects only Working; turning it off restores all states. It uses the state checkbox selection and is active only when Working is the sole selected state. Working plus Pending shows Working or chats with Pending or a visible ASB unread/question dot. Provider, search, and archive filters still restrict that union. Pending alone and other state combinations keep the existing Pending filter. The Drawer pill shows only the drawer rows, with their normal unread look. It combines with the app pills, search, the state filters, and the archive setting. It does not combine with Pending: turning one on turns the other off. While the pointer is on the Drawer pill and the drawer view is off, the drawer rows show their unread look in place (the peek). Change CSS only on visible drawer rows, with no list render. State selection uses four checkboxes, with All selected by default. The summary says **All states** or **N states**. **Clear** hides all sessions; **All** restores all four. Counts describe the filtered rows. Empty-result text expands to the available width. It follows the list: **No desktop sessions found…** shows only when the dashboard has no sessions. The empty drawer view says **The drawer is empty. Put an unread session in it to get it out of the way.** Use plain empty and error messages.

### Persistent unread

Use one native checkbox in Preferences > Sessions. It is off by default. The help text is **Use Read in the row menu to clear dots.** Save this setting through the shared ASB backend, separate from layout/theme. Synchronize dashboard values without sending them back. Disable the checkbox during its request; restore the current value and show an error on failure.

When on, retained ASB attention stays across source Read, source question resolution, and successful opens. **Read** clears local attention without changing the actual state or source data. Identify retained attention in the tooltip and accessible name. Hide unread while Working; only question attention makes a Working row Pending.

### View selection

Use one **View** dropdown in Preferences > Appearance: Compact or Comfortable. Save optional `view` in ASB's layout file. Width-only settings remain Compact. Changing width or resetting it preserves view. A mode change keeps all filters, search, pin order, focused session, and clamped horizontal scroll. Only row height/layout and capacity change. Opening stays in its fixed title block across mode changes. GNOME/custom colors apply to both.

A current synchronous Codex question can block execution and show Waiting. An async question only adds Pending attention and the `?` indicator; it cannot mask current Working or Idle. Real human resumption supersedes old requests; goal continuation, ambient context, and partial structured replies preserve them. Opening acknowledges local question attention without resolving source input. Keep question/answer text, call IDs, and request timestamps out of view payloads.

Leading `cl:`/`claude:` selects Claude and `cx:`/`codex:` selects Codex. Match case-insensitively, allow spaces, and treat unknown prefixes as literal text. A recognized prefix overrides the current app filter while present. A prefix alone selects that provider; following text keeps the title/folder/provider search. Keep the hint in a tooltip.

### Shared column width

Use one `Gtk.SpinButton` in Preferences > Appearance and native divider drag with a resize cursor. Any divider changes the shared target width. All columns stay equal; changing width recomputes the count and repacks all rows. Keep the drag controller on the persistent list container so row rebuilds do not end the drag. Divider hit tests use actual column positions in the long horizontal body, including after scrolling. Preserve focused ID, clamped scroll, and every session exactly once. Save only after a drag ends. **Reset width** returns to 240px and removes the saved width while retaining the selected view.

### App identity

Use the approved, unchanged Palatine MarkB disc for `local.asb.AgentSwitchBoard`. The launcher registers only the matching per-user hicolor icon and desktop entry. Preserve conflicting user launchers and report the conflict. Keep Claude and Codex row marks separate from this app identity.

### Theme controls

Offer **GNOME colors** and **Custom colors** in Preferences > Appearance. Give all five `Gtk.ColorDialogButton` controls a field-specific accessible name. **Apply theme** validates, saves, and applies to both the main and Preferences windows. Picker changes alone do not apply. **Reset to GNOME** deletes the custom file and restores system roles. Invalid saved settings show an error and retain GNOME colors.

## Do's and Don'ts

### Do:

- Do use native GNOME controls and semantic colors.
- Do keep a text label for each state.
- Do retain the chosen row height/layout and full tooltip details.
- Do validate custom colors before saving or applying them.

### Don't:

- Don't add a browser or webview to the native window.
- Don't treat all historical Idle sessions as Pending.
- Don't replace Working, Waiting, or Unknown with Pending.
- Don't pin a machine-specific theme, font, or accent as an ASB requirement.

## Refresh cadence

Native and web refresh runs every two seconds while any unarchived root session is Working, otherwise every five seconds. Use the complete list before filters. Keep this cadence when another app has focus. Local source-change events request a cached dashboard; they do not force a scan. Keep one read in flight and at most one follow-up. Both clients send the `ETag` of the dashboard that they show in `If-None-Match` and skip list updates on a `304` reply. Browser age labels still update once a minute through its existing refresh cycle. A background poll does not change the native Refresh button; make it insensitive only while a forced refresh is in flight or queued. Polling remains available if the event stream or file watch fails. Cold scanning and source writes can take longer than the interval. Activity-only observations do not rewrite ASB state.

Keep native rows by session ID, including rows hidden by search or filters. Create a row only when first shown; release it when its ID leaves the full dashboard or the window closes. Keep focus and clock work limited to visible rows, stop Read feedback when a row is hidden, and update cached source markers when the palette changes. Update current data, action state, and time labels before showing a cached row. Skip unchanged cached text and action updates. Repack when the visible ID set, view, or packing dimensions change. Reuse detached column containers across filters, bounded by the full dashboard count and current row capacity; source removal releases excess containers. An order-only change moves only changed rows inside the current columns, preserving keyed widgets/actions and avoiding explicit menu/scroll teardown. The visible cards glide to their new places, and the shared hover highlight is cleared when that motion starts. Keep focus when possible. Use surface layout signals with a single queued geometry check, not a permanent frame callback. A mode change can replace row content while retaining the row and its current action state.

Working time uses the current source task/request start only. Compact shows it beside Working; Comfortable uses the right metadata label. A local two-second clock updates labels and accessible text without a data read; tooltips use the current clock when queried. It stops when the full unarchived list has no Working session. Idle age labels refresh once a minute. Seconds show below one hour; longer durations show hours and minutes. Unknown start and non-Working states have no running timer. The backend sends a stable `workingSinceMs`, not elapsed time.
