# ASB Android: desktop themes, cards, and motion

Status: approved design, 2026-10-15. Builds on `docs/plans/android-companion.md`.
The desktop is the reference: `DESIGN.md`, `.impeccable/design.json`, and the
card code in `scripts/asb-native.py` (`set_palette`, `native_colors`,
`update_session_row`, `update_row_text`, `attention_indicator`,
`highlight_color`, `quiet_color`, `limited_color`, `display_source_color`).
When this file and the desktop code differ, the desktop code wins, except for
the touch decisions in section 1.

Do not write device serials, LAN addresses, home paths, or other machine
values into code, tests, docs, or commits. Use placeholders.

## 1. Decisions (from the user, do not change)

| Topic | Decision |
| --- | --- |
| Theme source | Follow the PC. The phone uses the palette that the PC window uses: the Custom five colors, or the resolved GNOME colors. |
| Views | Compact and Comfortable, as on the desktop. A switch in phone Settings. Default Comfortable on the phone. |
| Layout | Portrait phone: one vertical column. Landscape and other wide windows: desktop Column Flow (section 4a). The app supports rotation in both directions. |
| Touch | The corner shows what the desktop shows without hover: the Read target (dot or `?`) while attention shows, the pin control while pinned, the filled drawer glyph for a drawer row, and the armed Discard ring. Tap acts. Unpinned Pin, Put in drawer, and the Discard offer are in the session inspector. |

Touch adaptations that follow from the platform (not a user choice, keep them):
- Compact rows keep the desktop content and order, but have a minimum height
  of 48 dp, because Android needs 48 dp touch targets. The Comfortable card is
  68 dp at the default text size. Its text lines are in sp, so the card height
  follows the font scale (`comfortableCardHeight` in `Rules.kt`).
- Text size: Settings > Appearance has Small (0.85), Default (1.0), Large
  (1.15), and Larger (1.3). The app multiplies the system font scale by this
  factor for all screens. Unpair keeps it.
- Corner controls keep their 24 dp drawn circle and get a 48 dp touch area
  (`Modifier.minimumInteractiveComponentSize()` or an equivalent touch inset).
- Hover does not exist. The desktop hover highlight becomes the pressed
  highlight (section 4). The hover "looks read" rule does not apply.
- Sizes: desktop px become dp, desktop font px become sp.
- Comfortable cards have a 24 dp gap between cards in the one-column list,
  because touch has no hover highlight to show which footer belongs to which
  card. Column Flow can make this gap smaller, to 8 dp (section 4a).
- Filter pills follow the desktop pill: at least 28 dp high (they grow with
  large text), fully round, 12 sp label, no check icon, accent background when
  selected (48 dp touch area kept). The search field also has only a minimum
  height, and the top bar grows with it.
- The search field and pill outlines use the divider color only when it has
  3:1 contrast with the background (WCAG non-text contrast); else muted.

## 2. PC side: share the palette (worker A)

The phone reads one new top-level dashboard field:

```json
"palette": {
  "mode": "gnome" | "custom",
  "colors": { "background": "#rrggbb", "text": "#rrggbb", "accent": "#rrggbb",
              "muted": "#rrggbb", "divider": "#rrggbb",
              "success": "#rrggbb", "warning": "#rrggbb" }
}
```

`palette` is `null` until the window has published one.

- `success` is the GNOME `success_color` in GNOME mode (Working labels and the
  Read confirmation), and the custom `accent` in Custom mode.
  `warning` is the GNOME `warning_color` in GNOME mode (Waiting labels), and
  the custom `accent` in Custom mode.
- GNOME mode colors are exactly what `native_colors()` returns (with its accent
  fallback and its muted .72 and divider .3 mixes), plus `success_color` and
  `warning_color` from the same `lookup_color`.
- The native window publishes the palette with `POST /api/palette` after every
  palette apply: at start, after Apply theme, after Reset to GNOME, and after a
  GNOME style change that makes ASB apply its palette again (accent or color
  change). Send only when the value changed since the last successful send. A
  failed send is silent (log to stderr) and retried at the next apply.
- `POST /api/palette`: loopback only, same Host/Origin action checks, and the
  source token rule of the `/api/phone*` routes. Body exactly
  `{"mode": ..., "colors": {...}}` with all seven keys, `#rrggbb` (store
  lowercase), mode `gnome` or `custom`. Else 400. Reply `{"changed": bool}`.
  Not on the gateway allowlist (the phone only reads the dashboard field).
- The server keeps the palette in memory and saves it atomically to
  `$XDG_STATE_HOME/asb/palette.json` (`~/.local/state/asb/palette.json`),
  mode `0600`, so the headless service keeps the last palette after a restart.
  A bad file: ignore it, use `null`, and warn once on stderr (no `.bad` move
  needed; the next publish replaces it).
- `GET /api/dashboard` adds `palette` to the reply content before the ETag
  hash, so a palette change gives a new ETag. A palette change also sends the
  normal `dashboard` event so clients refresh.
- Tests (Node): route auth (token, Origin), body validation, lowercase save,
  file mode, restart reads the file, dashboard has the field, ETag changes when
  the palette changes. Python logic test: the payload builder for both modes
  (pure function, no GTK).
- Docs: `SYSTEM_OVERVIEW.md` (API table, local writes), `docs/PRIVACY.md`
  (the phone receives the color palette), `CHANGELOG.md` Unreleased.

## 3. Android theme (worker B)

- `Palette` model (`data/Models.kt`): parse `dashboard.palette`; unknown or
  missing keys fall back to the defaults below. Save the last good palette in
  `Store` (one JSON string) and use it at start and while offline.
- Fallback before the first palette: background `#222226`, text `#ffffff`,
  accent `#78aeed`, success `#8ff0a4`, warning `#f8e45c`; muted and divider are
  the .72 and .3 mixes of text into background (same math as `native_colors`).
- Port to Kotlin with unit tests that use values computed by the Python
  functions: `luminance`, `contrast`, `mix_color`, `highlight_color`,
  `quiet_color`, `limited_color`, `display_source_color`.
- The app is dark only (the desktop is dark only). `AsbTheme` builds a Material
  3 `darkColorScheme` from the palette: background and surface = background;
  onBackground and onSurface = text; primary = accent; onPrimary = background;
  onSurfaceVariant = muted; outline and outlineVariant = divider;
  surfaceContainer* and surfaceVariant = highlight (background 85% + accent
  15%); secondaryContainer (selected chips) = accent with onSecondaryContainer =
  background. Keep the Material error colors. No dynamic color.
- Status and navigation bars: transparent edge-to-edge over the background,
  light icons.
- Settings shows "Theme: follows the PC (GNOME colors | Custom colors)", read
  only, and "View: Compact | Comfortable" (segmented buttons, saved in Store).

## 4. Android cards (worker B)

Port the desktop rows. Read `update_session_row`, `update_row_text`, and the
`set_palette` CSS for every value; the values below are a summary.

Shared:
- Provider marks: the desktop SVGs in `assets/icons/asb-openai-symbolic.svg`
  and `assets/icons/asb-claude-symbolic.svg` (Simple Icons, CC0) as vector
  drawables, 14 dp, tinted with text at alpha .65 (alpha .4 on a limited row).
  Replace the current "cx"/"cl" circles.
- Source Soft dot: 6 dp fill plus 1 dp background rim (8 dp circle) at the
  lower left of the provider mark, only when `sourceShowMarker` and
  `sourceCount > 1`; fill = `display_source_color(sourceColor, [background,
  highlight])`.
- Indicator (one slot, priority `?`, dot, Discard ring, stop, from
  `attentionIndicator`): `?` 11 sp, weight 800, accent; dot 7 dp circle,
  accent; Discard ring 9 dp outer, 1.5 dp border, text color; stop 7 dp square,
  1 dp radius, muted.
- State label 11 sp: Working = success, Waiting = warning, others = muted.
  Follow `update_row_text` for Pending and drawer tones.
- Usage limit (`limitLeft > 0`): all text and the 12 dp clock in
  `limited_color`; provider alpha .4; source dot unchanged. The countdown
  uses `limitText` (port of `limit_text`): from 24 hours on, days and hours
  (`3d4h`, `3d0h`), else the Working format. The accessible text uses
  `spokenLimit` (`3 days 4 hours`). The Working timer does not change.
- "Opening…" replaces only the title while an open is in flight.
- The accessible description keeps everything that the current app says
  (state, attention, pinned, drawer, usage limit, source).

Compact (one line, min height 48 dp, horizontal padding 5 dp, spacing 6 dp):
provider mark, title 13 sp (one line, ellipsis, fills the space), indicator,
state label (or clock plus `Resets 4h32m` on a limited row, Working timer
beside Working as on the desktop). No corner buttons.

Comfortable (min height 68 dp at the default text size, padding 8 dp start/end, 2 dp top/bottom,
spacing 2 dp):
1. Workspace line: provider mark, 7 dp gap, folder basename 11 sp muted,
   ellipsis; 54 dp reserved at the end for the corner.
2. Title: 13 sp, max 2 lines, ellipsis, a 2-line block (2 x 16 sp), 21 dp start
   indent, 54 dp end reserve.
3. Footer, 21 dp start indent: state (or clock plus "Resets in") left, age,
   Working timer, or countdown right (11 sp muted).
4. Corner (top right, 8 dp from the end): the touch rules of section 1.
   Read target: 24 dp circle, accent, background text at alpha .08; tap =
   `mark-read`; on success show a check in `success` with a `success` alpha
   .12 background for 1.6 s. Passive `?` (action required) and the stop square
   have no action. Pin control (only when pinned): 24 dp circle with text alpha
   .12 background; tap = `unpin`. Drawer glyph (only for a drawer row): the
   filled glyph in accent (9x5 dp rounded box with a 3x1 dp handle, as in
   `set_palette`); tap = `drawer-out`. Armed Discard: the ring; tap =
   `keep-result`. Order from the end: pin, read, drawer, with a 2 dp gap.
   A row with an action in flight ignores taps on the card.
- Quiet Idle-read rule (Comfortable only): Idle rows without `unread`,
  `questionAttention`, or `pending` use `quiet_color` for title, folder, state,
  and age (read the fractions in `asb-native.py` near the `.asb-idle-read`
  CSS). It returns to normal while pressed.
- Drawer rows outside the Drawer view look read (no dot, read tones), as now.

## 4a. Rotation and Column Flow (worker B)

- The activity handles rotation normally (no `screenOrientation` lock, no
  `configChanges` hack). State that must survive rotation lives in the
  ViewModels or `rememberSaveable`: filters, search text, view, open sheet,
  scroll position, busy rows, Read confirmations, pairing flow. Add a test or a
  device check for each.
- Choose the layout from the window width (`BoxWithConstraints` or the window
  size): below 600 dp use the one-column `LazyColumn`; at 600 dp or more use
  Column Flow.
- Column Flow ports the desktop packing (`pack_columns` in `asb-native.py` and
  `DESIGN.md` Layout): target column width 240 dp,
  `columns = max(1, floor((width + 12) / (240 + 12)))`, row capacity from the
  viewport height and the row height of the view at the current font scale
  (48 dp Compact, 68 dp Comfortable at the default text size). Compact has no
  gap: `capacity = max(1, floor((height - 4) / rowHeight))`. Comfortable fits
  as many whole cards as fit with a gap of at least 8 dp:
  `capacity = max(1, floor((height - 4 + 8) / (card + 8)))`, then the rest of
  the height becomes the gap between cards, at most 24 dp:
  `gap = min(24, (height - 4 - capacity * card) / (capacity - 1))`. A column
  has `capacity - 1` gaps. A phone in landscape (about 340 dp list height)
  shows 4 Comfortable rows. Fill down a column,
  then across. Columns share the width of the visible area equally (the desktop
  visible-column rule) and are divided by a 1 dp divider line in the palette
  `divider` color. The strip scrolls horizontally (`LazyRow` of columns, each a
  plain `Column` of cards); there is no vertical scroll. Pin, filter, and
  search behavior do not change.
- Rotation keeps the first visible session in view as far as possible: before
  the layout changes, remember the ID of the first visible row; after it,
  scroll so that this row (or its column) is visible.
- Card motion (section 5) also applies in Column Flow; a change of the packing
  (rotation, resize, view change) shows the new layout at once, with no motion,
  as on the desktop.
- The message light and edge marks use the card places in both layouts; in
  Column Flow the edge marks are at the left and right edges (desktop rule).
  For a card in a column that is not visible, the light uses the card slot
  (card height plus the packing gap).
- Landscape keeps the top bar, search, and pills; on short heights they must
  not take more than about one third of the screen (use a compact top bar).

## 4b. Session inspector

The session inspector replaces the long-press row menu (desktop row panel,
option E). Touch and hold a card in either view to open it as a focusable
popup at that point, inside the safe area with a 16 dp margin. It is 300 dp
wide, or the window width minus 32 dp. The surface is 6% text in the
background, with a 1 dp ring from `edgeColor` (port of `edge_color`).
`rowPanelControls` and `rowPanelNote` (ports of `row_panel_controls` and
`row_panel_note`) map `rowMenuActions` to the switches, so it stays the only
rule source. Every change uses the existing actions. The panel covers the
snackbar, so it shows the current snackbar message as an 11 sp caption below
the switches. A failed action keeps its error for that row (desktop
`asb-panel-error`), in an error color with 4.5:1 contrast on the surface. A
successful action for the row, a change of the row state, or the row leaving
the board removes it. A successful poll removes only an error from a failed
dashboard load, not an action error. A control is disabled while its action
runs. When the action ends, the control that had the focus gets it back if it
is still there and enabled (desktop `restore_panel_focus`, `panelFocusReturn`).
Back, a tap outside, Open, or the row leaving the board closes it. A rotation closes it.

## 5. Motion (worker B)

- Card motion: `LazyColumn` items use `Modifier.animateItem(fadeInSpec,
  placementSpec, fadeOutSpec = null)`. Placement: a critically damped spring
  (`dampingRatio = 1f`, `stiffness = 360f`, which settles in about 350 ms).
  Fade in: the same feel, about 350 ms. A leaving card disappears at once
  (`fadeOutSpec = null`). No motion at the first render and after a view
  change (give the list a new key per view so it starts fresh).
- Pressed highlight: the palette highlight color behind the card, rounded 3 dp
  (the desktop session radius), fade in and out in 100 ms. No Material ripple
  on cards (use an `Indication` that draws the highlight).
- Read confirmation: the check shows for 1.6 s, then the slot shows the
  current state.
- Message light: keep the existing implementation; use the palette accent.
  shortcut: it uses final row places during a card motion, while the desktop
  uses painted places; upgrade if lights jump during reorders.
- Reduced motion: when the system animator duration scale is 0, all of the
  above are instant (Compose already does this for springs and tweens; check
  it), and the message light uses its existing reduced form.
- No permanent frame loop; the clock tick rules stay.

## 6. Checks

- `npm test`, `python3 test/asb_native_logic_test.py`.
- `cd android && ./gradlew --no-daemon testDebugUnitTest lint assembleDebug`
  (0 lint errors).
- Kotlin unit tests: palette math against Python values, palette parse and
  fallback, card text and tone rules (pure functions), corner control rules.
- Device check (when the phone is connected): both views, Custom and GNOME
  palettes, a reorder, a press, Read from the corner, reduced motion, and
  rotation both ways in both views (state kept, Column Flow in landscape).

## 7. Out of scope

A phone-side theme editor, hover behavior,
tooltips, pin drag reorder.
