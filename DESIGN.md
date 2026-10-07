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

The saved fields are `background`, `text`, `accent`, `muted`, and `divider`. Each is a six-digit `#RRGGBB` value. The background must have relative luminance at or below 0.12. Text, muted text, and accent must each have contrast of at least 4.5:1 against both the background and row highlight. Divider contrast must be at least 1.5:1 against the background.

The highlight mixes the background (85%) and accent (15%) in encoded RGB, with each channel rounded. Custom Working, Waiting, and Pending labels use the accent. Their text labels keep the states distinct. Validation errors retain the applied theme and saved file.

**The Local Theme Rule.** Apply colors only to ASB. Never change GNOME settings to match a preview.

## Typography

Inherit the current GTK font family and control typography. Do not add a font or record the current machine's font as a requirement. The frontmatter records only ASB's explicit row and state sizes. Control and caption styles remain native.

Compact keeps the title on one line. Comfortable wraps the title to two lines in a fixed 32px block. Both ellipsize at the end and use the same native font family and 13px title size. The tooltip carries the full title and folder.

## Layout

Column Flow uses equal-width native lists with a vertical divider between columns. Use the frontmatter spacing tokens for frame margins and columns. All real columns are in one horizontal native box, with no stacked pages or trailing empty columns.

Rows use 22px in Compact and 68px in Comfortable. Packing uses the available scroll area, not the whole window: `columns = max(1, floor((width + 12) / (column_width + 12)))` and `capacity = max(1, floor((height - 4) / row_height))`. The shared target width defaults to 240px and accepts 160–600px. A 360px window has one default column or two at 160px. Fill down a column, then move across. Create only the needed columns and continue left to right. The horizontal scrollbar is automatic; vertical scrolling is disabled. Ordinary wheel movement maps to the horizontal adjustment; trackpad X and Shift-wheel work too. Keep the visible-column width logic and equal widths across the full strip.

The native mock captures show one, two, and four default columns at window widths of 360, 680, and 1040 pixels. A 1080×248 window shows four default columns or six at 160px, with three complete Comfortable rows per column. These are checked sizes, not fixed column-count breakpoints. The default window is 420 by 900 pixels.

Use one `Gtk.WindowHandle` toolbar with search, a 16px disc app mark, menu, refresh, and native close. Codex, Claude, and Pending are native toggle pills in both views. Place pills and counts in that row at 680px or wider, and in the existing second short row below it at smaller widths. Keep them usable at 320px; counts can ellipsize. There is no separate title row or instructional footer. Keep native move, resize, and close behavior. Settings focus stays within an open popup during repacking, then returns to the remembered row after dismissal. Native autohide is enabled; one root capture/hit test dismisses outside clicks without intercepting popup surfaces or menu-button clicks. Do not change the app's outer border.

**The Whole Session Rule.** Keep provider, title, state, and attention within one activatable row. Compact uses one line; Comfortable uses one 68px Workspace-first row.

## Elevation & Depth

The session area is flat. It adds no row shadows or card surfaces. Dividers separate columns. GTK owns the toolbar, popover, dialog, and focus depth. A custom row highlight shows hover and focus.

## Shapes

Use the frontmatter session radius. The unread dot has minimum width and height (7px) and a round shape. Keep native shapes for buttons, entries, switches, dropdowns, color dialogs, and popovers.

## Components

### Session row

Use the same `Gtk.ListBoxRow`, accessible name, tooltip, focus/menu, pin drag, and open behavior in both views. Compact keeps the existing gray provider mark, title, dot, and state on one line. Comfortable uses a vertical box: provider plus folder basename and quiet optional pin above the two-line title, then dot/state left and relative age right. Full folder remains on hover. Ellipsize folder and age when space is short; preserve full state and dot at 160px. Keep padding on row content. Click or Enter opens a valid link; missing links disable activation.

Sort ASB-owned pins first in saved order. Sort unpinned Pending and Waiting attention next, then Working, Idle, and Unknown. Within each unpinned group, use newest activity first and ID as the tie-break. Do not import original-app pins. Always show the actual Working, Waiting, Idle, or Unknown label beside the dot. Pending is attention only. Reading a dot cannot change that state label.

New native unread shows a dot, including while Working. It does not make Working join Pending-only. ASB acknowledgment can suppress the local dot while retaining the original read truth. A new Read-to-Unread episode or completion can add it again. The accessible row name identifies current attention. Opening replaces only the title label with **Opening…**. Refresh and resize retain that inline state until the open finishes. Then restore the current title. Failures stay in the row tooltip and accessible description. Do not add per-open global banners.

### Focus and row menu

Use native focus. In custom mode, use accent for the focus outline and the entry's inset focus border (1px). Keep the row highlight behind hovered or focused rows. Up and Down move one sorted row; Left and Right move one column capacity. Home and End select the first and last row. Preserve the focused ID and clamped horizontal position. A normal refresh keeps user position; keyboard movement, mode changes, and resize reveal the focused row when needed.

Printable typing from a row or another non-editable area moves focus to search and enters the character. Escape clears the query and provider prefix while preserving explicit filters. Keep Ctrl/Alt/Super shortcuts, editable fields, popup typeahead, and Space/Enter control activation native. Escape closes an open native popup before clearing search.

Right-click, Menu, or Shift+F10 opens the native row menu. A row with an ASB dot offers **Read**; a row without one offers **Unread**. The menu also keeps **Pin**/**Unpin** and keyboard pin movement. Defer popup unparent until GTK finishes menu activation so window actions retain their ancestry. Keep the accessible row name's title, provider, state, manual mark, ASB pin, and unanswered-question cue.

Pinned rows have native `Gtk.DragSource`/`Gtk.DropTarget` reorder. Accept only an active drag from an ASB pin onto another known ASB pin. Dropping above/below the row midpoint places it before/after. Keep the full global order when some rows are filtered out. **Move pin earlier/later** is the keyboard fallback. Add no separate pin bar or project headers.

### Tooltip

Show the full title, folder, provider, state, update age, state reason, and read-marker source. Include pin status and missing-link information when applicable. Keep native unread, ASB completion, and ASB manual mark descriptions distinct.

### Search and filters

Use native `Gtk.SearchEntry`, `Gtk.DropDown`, `Gtk.CheckButton`, and toggle pills. Codex/Claude pills and the app menu use one selected-app set. No selection and both providers show all; one selects it. Pending is an independent AND filter. State selection uses four checkboxes, with All selected by default. The summary says **All states** or **N states**. **Clear states** hides all sessions; **All states** restores all four. Counts describe the filtered rows. Use plain empty and error messages.

### Persistent unread

Use one native checkbox in the existing menu. It is off by default. The help text is **Use Read in the row menu to clear dots.** Save this setting through the shared ASB backend, separate from layout/theme. Synchronize dashboard values without sending them back. Disable the checkbox during its request; restore the current value and show an error on failure.

When on, retained ASB attention stays across source Read, source question resolution, and successful opens. **Read** clears local attention without changing the actual state or source data. Identify retained attention in the tooltip and accessible name. Keep existing native-only Working Pending rules.

### View selection

Use one **View** dropdown in the existing menu: Compact or Comfortable. Save optional `view` in ASB's layout file. Width-only settings remain Compact. Changing width or resetting it preserves view. A mode change keeps all filters, search, pin order, focused session, and clamped horizontal scroll. Only row height/layout and capacity change. Opening stays in its fixed title block across mode changes. GNOME/custom colors apply to both.

A current synchronous Codex question can block execution and show Waiting. An async question only adds Pending attention and the 7px dot; it cannot mask current Working or Idle. Real human resumption supersedes old requests; goal continuation, ambient context, and partial structured replies preserve them. Opening acknowledges local question attention without resolving source input. Keep question/answer text, call IDs, and request timestamps out of view payloads.

Leading `cl:`/`claude:` selects Claude and `cx:`/`codex:` selects Codex. Match case-insensitively, allow spaces, and treat unknown prefixes as literal text. A recognized prefix overrides the current app filter while present. A prefix alone selects that provider; following text keeps the title/folder/provider search. Keep the hint in a tooltip.

### Shared column width

Use one `Gtk.SpinButton` in the menu and native divider drag with a resize cursor. Any divider changes the shared target width. All columns stay equal; changing width recomputes the count and repacks all rows. Keep the drag controller on the persistent list container so row rebuilds do not end the drag. Divider hit tests use actual column positions in the long horizontal body, including after scrolling. Preserve focused ID, clamped scroll, and every session exactly once. Save only after a drag ends. **Reset width** returns to 240px and removes the saved width while retaining the selected view.

### App identity

Use the approved, unchanged Palatine MarkB disc for `local.asb.AgentSwitchBoard`. The launcher registers only the matching per-user hicolor icon and desktop entry. Preserve conflicting user launchers and report the conflict. Keep Claude and Codex row marks separate from this app identity.

### Theme controls

Offer **GNOME colors** and **Custom colors**. Give all five `Gtk.ColorDialogButton` controls a field-specific accessible name. **Apply theme** validates, saves, and applies in the current window. Picker changes alone do not apply. **Reset to GNOME** deletes the custom file and restores system roles. Invalid saved settings show an error and retain GNOME colors.

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

Native and web refresh runs every two seconds while any unarchived root session is Working, otherwise every five seconds. Use the complete list before filters. Keep this cadence when another app has focus. Local source-change events request a cached dashboard; they do not force a scan. Keep one read in flight and at most one follow-up. Polling remains available if the event stream or file watch fails. Cold scanning and source writes can take longer than the interval. Activity-only observations do not rewrite ASB state.

Keep native rows by session ID. Update title, folder, state, dot, pin, tooltip, and accessible text in place. Repack only when visible IDs, order, view, or packing dimensions change. Use surface layout signals with a single queued geometry check, not a permanent frame callback. Disconnect and remove row controllers when a row leaves the view. A mode change can replace row content while retaining the row and its current action state.

Working time uses the current source task/request start only. Compact shows it beside Working; Comfortable uses the right metadata label. A local two-second clock updates labels, tooltips, and accessible text without a data read. It stops when the full unarchived list has no Working session. Idle age labels refresh once a minute. Seconds show below one hour; longer durations show hours and minutes. Unknown start and non-Working states have no running timer. The backend sends a stable `workingSinceMs`, not elapsed time.
