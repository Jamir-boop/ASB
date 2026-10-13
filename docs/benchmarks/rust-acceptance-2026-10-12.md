# Rust prototype acceptance record: 2026-10-12


Both the Python frontend and corrected Rust release build passed fourteen
critical native acceptance groups. No missing feature was found in those checks.
The Rust prototype and its harnesses were removed after evaluation and were
never released. These checks cannot be rerun from the current tree.

The matrix records the full Python feature requirement used for the evaluation.
A test coverage limit did not remove a feature requirement. The Node backend
and action routes were the reference. Backend fixture and semantic golden
checks did not establish native focus, accessibility, pointer behavior, or layout.

## Feature matrix

| Area | Required behavior | Evidence required |
| --- | --- | --- |
| Dashboard | Initial load, manual forced refresh, ETag/304, SSE reconnect, adaptive 2/5-second polling, queued refresh, errors and recovery, clean close | Transport tests and real-input checks |
| Data scope | All returned root rows, both providers, multiple sources, labels, visible/hidden profile dots, archived rows, missing direct links, partial source errors | Synthetic fixtures and visual checks |
| Views | Compact and Comfortable, full real row set, column flow, measured row height, equal column width, horizontal scrollbar, 160–600px width, divider drag, no vertical scroll | Packing goldens and native checks at wide/narrow sizes |
| Search | Title, project, folder, provider/source label, Unicode casefold, `cl:`/`claude:` and `cx:`/`codex:`, clear, Escape, printable-key entry | Goldens and real input |
| Filters | Codex/Claude pills and Preferences, Pending, Working, Working+Pending union, selected state sets, archive setting, no selected states | Goldens and ordered-ID checks |
| Drawer | Pill, archive-aware count, `99+`, mutual exclusion with Pending, hover peek, drawer-only unread look, empty text, narrow-column menu fallback | Real input, synthetic boundary fixtures, visual checks |
| State and attention | Working/Waiting/Idle/Unknown text, question/dot/Discard/stop priority, passive permission wait, quiet Idle-read text, Working without unread, drawer marks | Golden model checks and row-state visual checks |
| Metadata | Relative age, live Working duration, source names, subagent count, rich tooltip, full folder/title, state reason and action errors | Goldens and native tooltip checks |
| Opens | Valid row click/Enter opens exact ID route, absent link disables activation, no open from corner controls or pin drag, failure retains attention, busy deduplication | Recorded real UI requests |
| Read/Unread | Exact route/body, 1.6-second Read feedback, error retention, new attention cancels stale feedback, busy/disabled accessibility, half-second Discard guard | Real UI requests and state checks |
| Pins | Pin/unpin, saved order, visible-neighbor keyboard movement, actual drag and drop, row reuse and focus retention | Payload and native input checks |
| Discard/Keep | Working-only task arm, exact routes, readable ring/offer, native feedback, read guard, error handling | Payload and row-state checks |
| Drawer actions | Put unread rows in, take drawer rows out, Read clears drawer, passive questions cannot go in, controls do not open rows | Payload and native input checks |
| Preferences | One retained separate nonmodal window, raise/reopen, close hides, parent close destroys, selected section/form retained, sidebar/tabs breakpoint, scroll at small heights | Native window and focus checks |
| Sessions settings | Provider/state/archive controls stay synchronized; Persistent unread writes exact boolean and recovers on error | Recorded UI request and state checks |
| Appearance | View, width, reset, GNOME/custom mode, five color pickers, Apply/Reset, contrast validation, file read/write, failed save keeps prior applied/saved state | Config goldens, native controls, disposable file checks |
| Profiles | Lazy first load, retained form, reload, add/edit/remove, provider/name/path/launcher/transcript/color/dot/enabled fields, path chooser, max eight, builtin removal guard, explicit Save feedback | Recorded UI requests, native form and dialog checks |
| HTTP contract | Loopback base validation, Origin on actions, empty action objects, correct move-pin target/placement, source token only on source actions, parse/HTTP/truncated response failures | Transport tests and request records |
| Keyboard and focus | List navigation/reveal, Menu/Shift+F10, control Space/Enter, popover key routing, no focus theft on refresh/repack/settings | Real keyboard checks |
| Accessibility | Same row labels/tooltips, named toolbar/pills/controls, drawer count label, busy and disabled states, final layout during paint-only motion | GTK accessible-property checks |
| Motion | Shared 200ms hover and 100ms fade, about 350ms card motion, critically damped wheel spring, retarget/cancel rules, reduced motion, no permanent frame loop | Native animation checks and trace review |
| Lifecycle | Disconnect SSE, stop timers, release row controllers, cancel feedback/animations/dialogs, destroy Preferences and close process | Close/reopen and idle checks |

## Benchmark acceptance used in the evaluation

The comparison required the same synthetic fixture, backend process,
1182×350 window, font, theme, renderer, X11 display, animation setting, and view
within each pair. The corrected Rust release build and unmodified Python source
kept all real widgets and behavior. Trial order alternated. The target was at
least five repetitions for cheap operations, with 155, 1000, and 5000-row
fixtures where practical. The report records the actual counts and timing limits.

Required measures were startup with expired and preloaded snapshots, search to
paint, clear, Working/Pending filters, Drawer toggle/peek, wheel repaint cadence,
resize timing, idle CPU, and context switches. Frontend CPU/RSS/PSS stayed
separate from shared Node cost. Numeric samples and median/p95 were retained.
Five startup trials do not support a useful p99 claim.

All startup results use warm filesystem caches unless a separate cold-cache
method is recorded. Hidden Xephyr results are GTK repaint cadence. They are not
physical display FPS. Callback counts cannot establish frame presentation.
No performance conclusion is valid until both frontends run and feature parity
has been checked.

## Verification at evaluation

Verified for this work on 2026-10-12:

| Check | Result | What it establishes |
| --- | --- | --- |
| Rust default tests | 26 passed, 1 opt-in test ignored by default | Model, transport, config, source-form, and reply contracts, including Python semantic goldens. |
| Opt-in native regression | 1 passed separately | Tooltip-action cache reuse and invalidation. |
| Existing Node suite | 269 passed | Existing backend behavior and trust boundary. |
| Existing Python logic suite | 78 passed | Current Python reference behavior. |
| Harness checks | 7 passed | Current goldens, 155/1000/5000 fixtures, process/summary units, partial trace lines, real Node actions/settings, coordinate rounding, and active-scroll bounds. |
| Python critical native acceptance | 14 groups passed | Real native input against the current unmodified Python frontend. |
| Rust critical native acceptance | 14 groups passed | Same native input and fixture against the release binary. The final frontend log is empty. |

Each native acceptance run recorded requests, callbacks, frontend logs, and
eight synthetic captures in disposable folders. These raw records are not part
of the public archive. The corrected Rust log was empty.

The fourteen groups cover these actual interactions:

- Pinned Idle Read keeps focus when order is unchanged. Confirmed Read ignores
  Space, Return, and KP_Enter. Active Read accepts all three keys.
- Corner Read, drawer in/out, and pin/unpin send the expected requests. Context
  Unread and body open work. Corner controls do not also open the row.
- A passive permission indicator does not take key focus. Its click and the
  following keys cause no action or open. Discard/Keep work on a Working row.
- Shift+F10, arrow keys, and Return move a pin relative to its visible neighbor.
- Persistent unread writes the exact boolean. App/archive controls work. View,
  width, reset, theme Apply, and theme Reset write the expected local files.
- Preferences keeps its section and source draft across page changes and
  close/reopen. Profiles loads once. Name, color, and marker Save use the
  source-only token and persist the expected values.
- Narrow Preferences retains the draft. Both views have wide and narrow
  captures. Idle has no continuous repaint loop. Native WM_DELETE_WINDOW closes
  the process cleanly while a row menu is open.

Request records check route, body, Origin, source-token scope, and status. All
source and config writes use disposable folders. The toolbar structure was
reviewed: it uses `Gtk.WindowHandle`, and the native close control follows
Refresh. The hidden display has no real window manager, so this review does not
prove toolbar dragging on a physical desktop.

The prototype implemented the full feature set, and the checks found no known
missing feature. The following paths were not explicitly exercised by these native
groups: actual pointer pin drag/drop, divider drag, interactive file/color
dialogs, source Add/Remove/Refresh through the UI, live source stores, action and
save-failure recovery through the UI, all animation retarget/reduced-motion
cases, and full assistive-technology behavior. Model, config, transport, and
backend tests cover parts of those paths. They do not replace native input tests.
Other GNOME/GTK versions, fonts, scale factors, renderers, and physical desktop
composition were not checked by this native acceptance run.

The paired benchmark completed: 44 corrected-binary trials cover 155-session
Comfortable and Compact views, plus 1000-session Comfortable. See
[the benchmark report](python-rust-2026-10-12.md) and its
[sanitized numeric samples](python-rust-2026-10-12.json). The 5000-session fixture checks passed, but no
frontend timing at that size was run. No repaint callback count or hidden-display
result establishes physical display FPS.
