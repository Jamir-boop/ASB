# Column Flow

Mode: Operate. Platform: native Linux GNOME, GTK4 and Libadwaita.

The user approved option 2 from the five sample studies in `.impeccable/options/index.html`. This brief records the implemented native surface. The study files retain their earlier, unapproved-stage notes.

## Task

Find an existing Codex or Claude Desktop Code session, read its state, and open it in its own app. Support narrow and wide windows with high session density.

## Chosen surface

- One compact draggable native toolbar with search, disc app mark, settings, refresh, close, and Pending-only/counts. Narrow windows use a second short row for Pending-only/counts. No separate title or footer row.
- One 22px line per session: gray provider mark, title, optional 7px unread dot, and text state.
- Appearance in Preferences also offers Comfortable: the chosen Workspace-first 68px row with folder above a two-line title, then state left and age right. The user selected C, Corner pair: the Read dot sits beside the top-right Pin/Unpin control. Compact remains the default. Keep outer borders unchanged.
- Codex, Claude, and Pending are activate/deactivate pills in both views. Pills and the App field in Sessions share one selected-app set. No selection/both shows all; one selects a provider. Pending combines with the other filters. Narrow windows reuse the secondary row.
- Fill down each column, then across. Width sets column count; available height sets row capacity. Further columns scroll horizontally left to right. There are no vertical pages or empty trailing columns. Ordinary wheel input maps horizontally.
- One shared target column width defaults to 240px, with a 160–600px range. Any divider drag or the accessible Appearance field changes all columns. Save only ASB's layout config. A 360px window has one default column, or two at 160px.
- Packing uses the selected 22/68px row height. Optional view shares the layout file; width-only files load Compact. Width reset preserves Comfortable. Mode changes keep filter/search/pin/focus state and clamped horizontal position, revealing off-screen keyboard focus. Three complete 68px rows fit 1080×248.
- Put ASB pins first in saved order, then unpinned Pending/Waiting, Working, Idle, and Unknown. Keep original-app pins separate. Native row drag and earlier/later menu actions reorder ASB pins without losing hidden pins.
- Hover shows the full title, folder, state reason, and marker source. Keyboard movement and the native row menu remain available.
- Prefix search supports `cl:`/`claude:` and `cx:`/`codex:`. Printable typing from a non-editable area enters search; Escape clears query/prefix and keeps explicit filters. Native popups and modified shortcuts keep their keys.
- Combine state checkboxes. All four are selected by default. **Clear** hides all until a state is selected; **All** selects all four.
- Opening appears only in the row's title space and survives refresh/resize. Restore the current title afterward; keep failures in the row tooltip.
- Use GNOME dark colors by default. Apply validated custom colors only within ASB.

## Preferences, approved Option B

The toolbar settings button opens one separate, nonmodal native Preferences window. Repeated selection raises the same window. Closing it hides it, keeps the main window running, and keeps the selected section and form edits. Main shutdown destroys it.

Use left `Gtk.StackSidebar` navigation at wide widths and `Gtk.StackSwitcher` tabs above the page at `max-width:600px`. **Sessions** holds app/state/archive filters and Persistent unread. **Appearance** holds view, shared width/reset, and GNOME/Custom colors with five pickers, Apply theme, and Reset to GNOME. Both windows use the applied theme. Page content scrolls when height is small.

**Profiles** embeds the existing source table and editor, with all fields, default locks, Add/Save/Remove/Cancel/Refresh, validation, status, and authenticated API actions. Create and load it only on the first visit; explicit source actions keep their existing load behavior. Section changes and reopening keep form edits without a reload. Add no timer, background scan, backend route, or dependency. Main cards, borders, and scrolling keep their current behavior.

## Comfortable Corner pair

The pin appears on row hover or keyboard focus and stays visible while pinned. The Read target appears for current ASB attention. Its hover/focus cue is a check. Select either control without opening the row or starting a pin drag. Space or Enter activates the focused control. Pin/Unpin uses the existing API and real saved order; row drag and keyboard menu reorder remain available.

Both circular targets have a minimum size of 24×24px with a 2px gap. Their `Gtk.Overlay` does not affect row measurement. Folder and title reserve 62px at the right, including the content inset. Keep the 68px card, fixed title block, footer state/time, frame, and Compact layout. Use GNOME semantic colors or the saved custom palette.

A successful Read clears only ASB attention and shows a check for 1.6 seconds. Failure keeps the dot and adds the error to the row tooltip. Read works with either Persistent unread setting; it cannot change execution, source read state, or source question resolution. Current row identity, view, feedback generation, and attention guard the result. New unread clears old feedback.

Pending controls keep pointer sensitivity and native gesture handling but have no action bindings. They report accessible `BUSY` and `DISABLED`. The confirmed Read control has no action binding and reports `DISABLED`. Both remain separate from row opening.

## Attention behavior

Pending is separate from task state. Use matched local Codex unread metadata when safe. Otherwise, use a new successful Working-to-Idle completion observed by ASB. The first scan does not mark historical Idle rows. Waiting keeps its label.

New native unread shows a dot. Working remains Working and does not join Pending-only from native unread alone. ASB read acknowledgment suppresses local attention until a real new unread episode or completion. The row accessible name includes the current attention cue. Forced refresh waits for an in-progress read, so a manual mark can appear promptly.

Question attention is independent of execution. Only a current blocked synchronous question can show Waiting. Async requests keep Working or Idle. Real human input supersedes old requests; automatic goal/context and partial replies preserve them. Opening acknowledges the ASB dot without resolving source input. Show only a bool/reason, never question/answer text or request timestamps.

**Unread** persists only in ASB and adds Pending attention and a dot. Every row retains its actual state label. By default, a successful ASB open acknowledges local manual, completion, native, and question attention. A failed open retains it. Original app data remains read-only. **Persistent unread** in Preferences > Sessions retains ASB attention across source read/resolution and opens. It is off by default. **Read** in the native row menu clears it. The setting belongs to shared ASB state, separate from layout/theme; current execution labels and native read truth stay unchanged.

## Evidence and limits

`scripts/asb-native.py`, `src/switchboard.mjs`, and `test/asb_native_test.py` are the implementation and check sources. Native captures in `.impeccable/review/horizontal/` use mock sessions at 360×800, 680×800, 1040×800, and 1080×248, plus six-column, inline Opening, Pending-only, and custom-theme states. They show layout, not real account data or a performance benchmark. The 1080px six-column preview starts at the top of the list.

The current code validates contrast on the custom background and row highlight and names each color control. This brief does not claim a complete assistive-technology audit. The Impeccable platform enum and HTML specimen format do not represent GTK; `.impeccable/design.json` records native details in extensions instead.

The C Corner pair code and logic review found no remaining P1/P2 issue in that scope. No native UI tests or new native screenshots were run for this change. Earlier mock captures do not verify the new controls. Native pixel fidelity remains unverified.

Preferences passed two focused GTK tests on an isolated nested X display, with Cairo and synthetic data. Six captures in `.impeccable/review/preferences/` were inspected at 780px and 420px widths, including the three sections and a custom theme. The full GTK suite did not run. The physical desktop was not changed. These checks do not cover all assistive technology or GNOME versions.

Native and web clients refresh at two seconds while any full-list unarchived root session is Working, otherwise five seconds. Focus and filters do not slow monitoring. Local source-change events request a cached read, with polling as a fallback and at most one pending follow-up. Native rows stay keyed by session ID; timestamp and state changes update existing fields. Only order, visible IDs, view, or packing changes move rows. Layout signals replace permanent frame checks. Removed rows disconnect their controllers. Cold load may take longer than the interval. List repacking does not rebuild Preferences controls or take their focus.

The row menu shows **Read** when the current ASB dot is present and **Unread** when it is absent. Pin and keyboard reorder actions remain available.

Working time uses the current source task/request start only. Compact shows it beside Working; Comfortable uses the right metadata label. A local two-second clock updates labels, tooltips, and accessible text without a data read. It stops when the full unarchived list has no Working session. Idle age labels refresh once a minute. Seconds show below one hour; longer durations show hours and minutes. Unknown start and non-Working states have no running timer. The backend sends a stable `workingSinceMs`, not elapsed time.
