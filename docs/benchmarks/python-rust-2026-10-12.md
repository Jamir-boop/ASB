# Python/Rust prototype benchmark: 2026-10-12

Rust starts faster and uses less frontend PSS in all three measured cases.
Interaction results are mixed. At 155 sessions in Comfortable, Drawer-on and
some list changes have slower Rust medians. Repaint cadence is close; these
measurements do not establish a physical display FPS gain.

The Rust prototype and its benchmark harnesses were removed after evaluation. The prototype was never released. This report is a historical record; the experiment cannot be run or reproduced from the current tree. Production ASB remains Python at `1.7.0`; the evaluated Rust prototype version was `0.1.0`.

## Normal-size headline: 155 sessions, Comfortable

Values are median / p95. Startup n=5 per snapshot condition and frontend;
all other samples n=10 per frontend.

| Measure | Python | Rust |
| --- | --- | --- |
| Snapshot-warm startup, ms | 435.14 / 440.60 | 318.79 / 332.56 |
| Frontend final PSS, MiB | 117.67 / 118.16 | 100.13 / 100.49 |
| Search, ms | 16.99 / 19.62 | 12.33 / 20.18 |
| Drawer on, ms | 11.77 / 22.12 | 14.24 / 28.22 |
| Resize narrow after repack, ms | 31.86 / 32.60 | 29.76 / 33.19 |
| Resize restore after repack, ms | 24.53 / 30.58 | 26.26 / 28.06 |

## Builds and host

All 44 final trials use the corrected release binary. A missing Rust
tooltip-action cache was repaired and tested before these runs. Earlier Rust
measurements are excluded. Python source is unchanged.

| Item | Value |
| --- | --- |
| Rust build | Corrected release binary, now removed |
| SHA256 | `ddafeb8c033a7623707f42b538d41f23eb9ec567c2b4f48488741ad66cf5bf44` |
| CPU / memory | Intel Core i9-12900KF / `MemTotal: 32714516 kB` |
| Kernel / libc | Linux `6.12.111+deb13-amd64` / glibc `2.41` |
| Python / Node / Rust | `3.13.5` / `24.20.0` / `1.99.0` |
| GTK / Libadwaita | `4.18.6` / `1.7.6` |
| Display / renderer | X11, hidden Xephyr, Cairo |
| Window / font | 1182×350 pixels / `Cascadia Code NF 11` |
| Theme / animations | Same isolated GTK/Xft settings; GNOME colors; animations on |

## Method and samples

Both frontends use the same Node process within each paired run. The fixture
host calls the real `createSwitchboardServer`, `PendingTracker`, and
`AppSourceRegistry`, with synthetic dashboard data and a no-op app opener.
All real rows, controls, and behavior stay enabled. Each frontend has temporary
HOME/XDG folders and its own session bus. The installed ASB is untouched;
original app stores and credentials are outside these tests.

The order alternates Python/Rust and Rust/Python. Builds stop before timing.
Xephyr runs under an unmapped parent. A fake `_NET_WM_CM_S0` selection owner
selects the composited X11 code path, with no compositing renderer.

| Sessions / view | Repetitions | Trials | Startup n per condition/frontend | Operation n per frontend |
| --- | --- | --- | --- | --- |
| 155 / Comfortable | 5 | 20 | 5 | 10 |
| 155 / Compact | 3 | 12 | 3 | 6 |
| 1000 / Comfortable | 3 | 12 | 3 | 6 |

`cold` means an expired dashboard snapshot; `warm` means a snapshot loaded before
frontend launch. Filesystem caches are warm in both cases. Kernel caches are
not flushed, so these are not cold disk measurements.

Startup ends at the first GTK `after-paint` after list render. Input latency
starts before XTest dispatch and ends after the required state has rendered.
Search and filter ordered IDs must match the Python reference. Operations are
separated by a settling interval. Resize ends at the first paint after the
resize-driven list render/repack, excluding the earlier outer-window paint.
It changes 1182×350 to 1100×350 and back.

Active-scroll intervals include each segment's final frame and exclude gaps
after the spring stops. They measure GTK repaint cadence, not presentation or
physical display FPS. CPU uses process ticks; small samples can quantize to zero.
Idle windows last about 3 seconds. Context switches are not wakeup counts.
RSS counts shared mapped pages in each process; PSS divides them. Frontend and
shared Node cost stay separate. Only PSS has a combined figure in the raw data.
Synthetic backend cost does not measure original app-store scanning.

P95 uses nearest rank. With three or five startup samples it is the maximum
observation, not a stable tail estimate. No useful startup p99 claim is made.
Full median/p95 values and raw numeric samples are in
[numeric results](python-rust-2026-10-12.json), with no session IDs or trace
contents.

## All operation medians

Each cell is Python / Rust in ms. Counts are shown above. P95 and dispatch/CPU
samples remain in the numeric JSON.

| Operation | 155 Comfortable | 155 Compact | 1000 Comfortable |
| --- | --- | --- | --- |
| Snapshot-cold startup | 438.10 / 334.21 | 300.65 / 221.44 | 1471.31 / 995.61 |
| Snapshot-warm startup | 435.14 / 318.79 | 298.22 / 224.35 | 1770.05 / 990.76 |
| Search | 16.99 / 12.33 | 16.97 / 8.02 | 79.04 / 63.06 |
| Clear search | 33.39 / 34.62 | 18.48 / 18.22 | 207.32 / 172.13 |
| Working on | 21.88 / 13.18 | 20.11 / 17.19 | 83.73 / 69.07 |
| Working + Pending union | 27.39 / 31.70 | 15.00 / 14.17 | 120.03 / 116.09 |
| Pending only | 20.23 / 19.68 | 21.18 / 18.94 | 82.63 / 86.38 |
| Pending off | 39.28 / 40.02 | 17.06 / 16.64 | 216.83 / 173.10 |
| Drawer on | 11.77 / 14.24 | 13.58 / 13.87 | 47.98 / 64.75 |
| Drawer off | 35.55 / 32.59 | 21.10 / 21.97 | 214.79 / 173.60 |
| Drawer peek | 7.22 / 7.09 | 2.55 / 2.19 | 45.56 / 44.18 |
| Drawer peek leave | 7.73 / 7.58 | 2.78 / 2.64 | 57.41 / 55.19 |
| Resize narrow after repack | 31.86 / 29.76 | 24.41 / 23.69 | 51.26 / 48.93 |
| Resize restore after repack | 24.53 / 26.26 | 26.88 / 26.93 | 38.65 / 23.18 |

## Memory and CPU medians

Each cell is Python trial / Rust trial. Node is the same shared backend, sampled
beside the active frontend. Memory and CPU n=10 per frontend at 155 Comfortable,
and n=6 for the other two cases. Final memory follows the interaction sequence.

| Measure | 155 Comfortable | 155 Compact | 1000 Comfortable |
| --- | --- | --- | --- |
| Frontend final RSS, MiB | 211.48 / 184.07 | 200.37 / 173.08 | 324.72 / 289.62 |
| Frontend final PSS, MiB | 117.67 / 100.13 | 106.62 / 89.18 | 230.95 / 205.77 |
| Node final RSS, MiB | 87.57 / 87.12 | 86.43 / 85.77 | 107.24 / 108.00 |
| Node final PSS, MiB | 61.21 / 60.66 | 60.06 / 59.40 | 79.62 / 80.37 |
| Frontend first-list CPU, seconds | 0.510 / 0.460 | 0.380 / 0.320 | 1.530 / 1.060 |
| Frontend total CPU, seconds | 1.400 / 1.305 | 1.290 / 1.180 | 3.765 / 3.020 |
| Shared Node trial CPU, seconds | 0.020 / 0.020 | 0.020 / 0.020 | 0.065 / 0.050 |
| Frontend idle CPU, % of one core | 0.666 / 0.666 | 0.999 / 0.833 | 1.332 / 0.999 |
| Shared Node idle CPU, % of one core | 0.000 / 0.000 | 0.167 / 0.000 | 0.333 / 0.000 |

The JSON also retains first-list RSS/PSS, combined PSS, per-operation CPU,
individual idle windows, context switches, p95, and all numeric samples.
Zero CPU samples do not establish zero backend work.

## Pooled active-scroll intervals

Each cell is Python / Rust. Intervals within a trial are correlated; pooled
interval counts are not independent trial-level repetitions.

| Measure | 155 Comfortable | 155 Compact | 1000 Comfortable |
| --- | --- | --- | --- |
| Interval samples / active frames | 544 / 547 | 316 / 317 | 264 / 263 |
| Median interval, ms | 16.18 / 16.42 | 16.80 / 16.66 | 16.42 / 16.39 |
| P95 interval, ms | 20.15 / 19.48 | 19.06 / 18.78 | 42.63 / 42.03 |
| P99 interval, ms | 22.29 / 23.20 | 20.39 / 21.21 | 59.88 / 58.08 |
| Intervals above 50 ms | 0 / 0 | 0 / 0 | 7 / 8 |
| Intervals above 100 ms | 0 / 0 | 0 / 0 | 0 / 0 |

Active-frame counts equal interval counts in these samples. No physical display
FPS or wakeup count is inferred.

## Assessment and feature limits

Warm-start medians are 25–44% lower with Rust; final frontend PSS is 11–16%
lower. At 155 Comfortable, Rust's Working+Pending union, Drawer-on, clear,
Pending-off, and resize-restore medians are slower. At 1000 Comfortable,
Drawer-on and Pending-only are slower. Compact also has small regressions on
Drawer toggles and resize restore. The port is not uniformly faster.

Scroll intervals are close in all cases. Neither 155-session view has a sample
above 50 ms. At 1000 sessions, Python has seven such intervals and Rust has eight.
The small trial counts and CPU tick size limit broader conclusions.

Both frontends passed fourteen critical native groups. The corrected Rust
frontend log was empty. Each acceptance run had eight synthetic captures.
Checks include 26 default Rust tests, one separately run opt-in GTK tooltip
cache regression, 269 Node tests, 78 Python logic tests, and seven harness checks.
Rust model tests consume Python semantic goldens.

No missing feature was found in the tested cases. The historical feature
requirements and acceptance evidence remain in
[the acceptance record](rust-acceptance-2026-10-12.md). Pointer pin/drop and divider drag, interactive dialogs,
source Add/Remove/Refresh through the UI, live stores, UI failure recovery, all
motion/reduced-motion cases, full assistive technology, and other GNOME/GTK,
font/scale/renderer/physical-compositor configurations were not fully exercised.
Toolbar `Gtk.WindowHandle` and native close placement were reviewed; physical
window-manager dragging was not tested. The 5000-session fixture/golden checks
passed, but frontend timing at that size was not run. No extrapolation is made.

The archived numeric samples support review of these results. Removed code,
harnesses, and raw traces are not part of this archive.
