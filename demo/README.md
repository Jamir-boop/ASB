# ASB release demo

This isolated Remotion project renders the ASB `1.0.0` release media. Its packages are development dependencies in this directory. ASB does not load them at runtime.

The film is an authored interface simulation with synthetic session titles and folders. It is not a screen recording. The last app window illustrates a handoff to an existing Codex session. The demo does not read local provider stores, open real sessions, call models, or change user settings.

## Render

Use Node.js 22 or later, Chromium, and FFmpeg. Install and render from this directory:

```bash
npm ci
npm run check
npm run render
```

The default browser path is `/usr/bin/chromium`. To use another installed browser or FFmpeg path:

```bash
REMOTION_BROWSER_EXECUTABLE=/absolute/path/to/chromium FFMPEG_EXECUTABLE=/absolute/path/to/ffmpeg npm run render
```

`npm run poster` renders only the banner, video poster, and story frames. `out/` and `node_modules/` are ignored. The render uses the official [bundle](https://www.remotion.dev/docs/bundle), [renderStill](https://www.remotion.dev/docs/renderer/render-still), and [renderMedia](https://www.remotion.dev/docs/renderer/render-media) APIs. All animation uses frame numbers. There are no CSS timers or external assets at render time.

## Outputs

| File | Format |
| --- | --- |
| [Banner](../docs/media/asb-banner.png) | 1600 × 680 PNG |
| [Demo](../docs/media/asb-demo.mp4) | 24 seconds, 1280 × 720, 30 fps, H.264, silent |
| [README demo](../docs/media/asb-demo.gif) | 24 seconds, 960 × 540, 12 fps, looping GIF |
| [Video poster](../docs/media/asb-demo-poster.png) | 1280 × 720 PNG |

The GIF uses a 128-color palette to limit its download size. Use the MP4 for full motion quality. Use the static banner or poster when animation is unsuitable.

## Story

| Seconds | Example |
| --- | --- |
| 0–2 | ASB and the approved disc |
| 2–5 | Codex and Claude Desktop Code in one local list |
| 5–7 | Working, Idle, and Waiting with separate unread dots |
| 7–10.5 | Compact, Comfortable, and horizontal columns as the window narrows |
| 10.5–14 | `cl:` and `cx:` search |
| 14–16 | Claude and Pending pills |
| 16–19.5 | ASB pin and drag order |
| 19.5–21 | Read clears a local dot and keeps Idle |
| 21–22.5 | Open the existing session in its original app |
| 22.5–24 | ASB release close |

The native list simulation follows the row heights, column packing, toolbar, state, search, and attention rules in [ASB.md](../ASB.md) and [DESIGN.md](../DESIGN.md). It uses one fixed GNOME-like dark sample palette. The real app inherits GNOME colors or the user's validated ASB colors.

## Asset origin and licenses

The code and authored release media use the repository's [MIT license](../LICENSE). Third-party software and font files retain their own licenses.

- `src/Film.jsx` is the source for the banner, film, and poster. `src/story.mjs` supplies all synthetic data and the frame schedule. No photo, live screenshot, or AI raster asset is used.
- `public/disc.svg` is an unchanged copy of `assets/icons/local.asb.AgentSwitchBoard.svg`, the user-approved Palatine Mark B. See the public [disc provenance](../assets/icons/ASB-disc-provenance.md). SHA256: `c5c9c4472ef283ef8c3eaa1ff3f4758f5e52bb642ed91a3997b36f0a27bf41a0`.
- `public/openai.svg` and `public/claude.svg` are unchanged copies of the ASB provider SVGs. Their Simple Icons source and CC0 license are recorded in [provider provenance](../assets/icons/README.md). Brand rights remain with their owners.
- `public/fonts/Cantarell-VF.otf` is the GNOME Cantarell font. The copied [license and copyright](public/fonts/Cantarell-LICENSE.txt) use SIL OFL 1.1. The file is bundled for repeatable rendering, not added to the native app.
- `public/fonts/Syne.ttf` is the unmodified [Syne variable font from Google Fonts](https://github.com/google/fonts/tree/main/ofl/syne). The copied [license](public/fonts/Syne-LICENSE.txt) uses SIL OFL 1.1. Syne is used only in the release poster text.
- Remotion packages are pinned to `4.0.534`. Remotion has a [separate software license](https://www.remotion.dev/license), copied in [Remotion-LICENSE.md](licenses/Remotion-LICENSE.md). Its free license covers individuals, nonprofits, and for-profit organizations with up to three employees. Other users must check its company license terms before they use the renderer. ASB's MIT license does not replace those terms.

The sample palette is `#111113` (ground), `#242424` (window), `#343434` (controls), `#f6f3ed` (text), `#b3b0aa` (muted), `#4a4844` (divider), `#ffb900` (amber), and `#8fce8a` (Working). Amber follows the approved disc. It is not a permanent GNOME theme requirement.

## Checks

`npm run check` verifies the synthetic story rules: a Working native dot does not become Pending, provider prefixes filter correctly, pin order changes in ASB, menu actions match the current dot, Read keeps Idle, and each frame has unique valid sessions. The banner and story frames were inspected together. The visual correction batch fixed the banner spacing, menu cursor positions, and the narrow toolbar. A separate review corrected the pin menu's Read label and kept the focused session visible after Read, with the true sort order. This is media verification, not an application UI test.
