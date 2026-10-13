# Python X11 frame-timing investigation: 2026-10-13

Keep Python and the existing X11 workaround. These tests found no safe app-only
240 Hz fix. Removing frame synchronization, changing the portrait resolution,
and using GLX did not improve useful scroll timing. Resize lag remains unresolved.

This is a historical report. The prototype harnesses were removed after
evaluation. Temporary investigation code is not retained in this repository.
They were never released, and these experiments cannot be run or reproduced
from the current tree. No production code or permanent
display setting changed. Raw traces, readiness records, and session records are
not part of this archive.

## Setup and method

| Item | Value |
| --- | --- |
| ASB | `1.7.0`, Python frontend |
| OS / desktop | Debian `13`, GNOME X11, Mutter `48.7` |
| GTK / Libadwaita | `4.18.6` / `1.7.6` |
| GPU / driver | NVIDIA RTX `4070 SUPER` / `550.163.01` |
| Original monitors | Primary `1920×1080 @ 239.76 Hz`; portrait `1080×1920 @ 60 Hz` |
| Fixture / view | 155 synthetic sessions, 149 visible rows, Comfortable |
| Content / columns / font | `1182×350`, `212px`, `Cascadia Code NF 11` |
| Input | 25 programmatic wheel-handler calls, 80 ms apart |

Each test used an owned, isolated app on the actual primary monitor. Original
app stores and credentials were outside the tests. There was no hardware input
capture. Programmatic calls measure app behavior, not hardware input latency.
The real widgets, features, and animations stayed enabled.

Active intervals include scroll and settling frames; idle gaps are excluded.
Changed-scroll intervals use callbacks where the scroll position changed.
CPU is process CPU during the scroll phase, as a percentage of one core.
CPU ticks and the small number of runs limit precision. P95 uses nearest rank.
All timing values below are milliseconds unless stated otherwise.

## Original display layout

The installed realize hook disables compositor-feedback frame synchronization.
GTK reported `16667 µs`, consistent with its documented 1/60-second fallback
when refresh history is absent. [GTK refresh information](https://docs.gtk.org/gdk4/method.FrameClock.get_refresh_info.html).

| Case | Active interval n | Active median / p95 | Changed-scroll interval n | Changed-scroll median / p95 | Scroll CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current fallback | 142 | 16.6599 / 17.7644 | 125 | 16.6713 / 33.4202 | 28.54% |
| Native synchronization, default graphics | 114 | 16.6979 / 33.6461 | 107 | 16.7453 / 33.7710 | 5.01% |
| Current fallback with `GDK_DEBUG=no-vsync` | 16926 | 0.0622 / 0.0720 | 111 | 16.7388 / 55.0151 | 89.83% |

`no-vsync` produced 16927 active callbacks, but only 119 distinct frame-clock
times and 112 callbacks with scroll-position changes. Repeated callbacks do not
show faster animation or physical display FPS. Changed-scroll p95 and CPU were
worse in this run. No useful speed gain was found.

## Temporary portrait-mode tests

The first display trial failed its mode assertion before measurement because
`--panning` reset monitor positions. Its data was excluded. The exact original
display configuration was restored manually before the corrected trials.

Mutter's code selects the output with the greatest overlap. It sorts outputs by
name and keeps the first on equal overlap. On this layout, equal monitor pixel
areas selected the 60 Hz portrait for refresh feedback. This source analysis
explains the feedback selection, not the full timing delay.
[Mutter 48.7 refresh selection](https://github.com/GNOME/mutter/blob/48.7/cogl/cogl/cogl-xlib-renderer.c#L419-L440).

The approved temporary `900×1600` portrait mode removed the equal-area tie.
Native feedback changed to `4171 µs`; the primary monitor stayed at
`239760 mHz`. In the first completed reduced-mode run, 89 active intervals had
median `32.8709` and p95 `33.9616`, with scroll CPU `3.50%`. Changing feedback
did not improve useful speed.

Three later reduced-mode cases gave the following results. Each had `4171 µs`
feedback. All graphics settings applied only to the owned app process.

| Case | Active interval n | Active median / p95 | Paint median | Between-paint gap median | Scroll CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| Native default, EGL | 70 | 33.2796 / 34.2882 | 0.8128 | 32.4975 | 4.01% |
| Native GLX, VSync off | 71 | 33.2977 / 34.2288 | 0.8972 | 32.3958 | 4.50% |
| Native GLX, primary-device selection | 71 | 33.3153 / 34.4295 | 0.7674 | 32.5862 | 4.48% |

Paint work was short compared with the gap between paints. EGL, unsynchronized
GLX, and primary-device GLX all stayed near 33 ms. No global NVIDIA setting
changed. The original display configuration was restored exactly after all
trials. These results do not support a permanent resolution or bypass-flag change.

## Native frame-message probe on the original layout

A final owned-process probe used the original display layout and native default
EGL synchronization. It paired GTK paint callbacks with `FRAME_DRAWN` delivery.
The table includes 105 adjacent intervals. One pair ends at a settled paint;
requiring both endpoints to be strictly active leaves 104 intervals.

| Interval | n | Median | p95 |
| --- | ---: | ---: | ---: |
| Paint | 105 | 0.703067 | 1.777507 |
| After-paint to `FRAME_DRAWN` receipt | 105 | 16.154091 | 32.783784 |
| Receipt to next paint | 105 | 0.036070 | 0.082923 |

The message buffer captured 214 messages, with zero drops and zero callback
errors. All physical-presentation timestamps were zero. Receipt is GDK message
delivery time, not physical presentation. The exact driver, Mutter, and message
delivery contributions to the wait remain unknown. These values establish no
physical display FPS result.

The probe exited with status 0. Its session guard exited with status 1 because
pointer restoration timed out (`pointer_restore:TimeoutExpired`). Installed ASB
window geometry and the monitor configuration were both restored exactly.
The guard result is separate from the timing result.

## Decision and future checks

Keep the current Python workaround. A distro change alone is not a proven fix.
The trials do not resolve resize lag or establish a complete graphics-stack cause.
The separate [Python/Qt comparison](python-qt-2026-10-13.md) also found no meaningful
scroll speed gain in its valid manual pair.

After a stack change, record exact OS, desktop, GTK, driver, renderer/context,
display protocol, and monitor versions and rates. Retest the same fixture and
geometry on the high-rate monitor. Compare scroll, Drawer, resize, intervals,
and CPU. Add a single-monitor versus mixed-monitor comparison, which has not
been done. Keep callback timing separate from physical FPS. Verify features,
input, actions, and accessibility before changing the workaround.
