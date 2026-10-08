# ASB release demo

This isolated Remotion project renders the ASB `1.0.0` release media. Its packages are development dependencies in this directory. ASB does not load them at runtime.

The local film shows four clicks between existing sample Codex and Claude Desktop Code chats. It uses a small ASB window beside overlapping app windows. Each app keeps its selected chat, project, static conversation history, and empty composer. This is an illustrated desktop, not a screen recording. It reads no provider stores, opens no real chats, and makes no model calls. The user reference screenshots supplied layout only; their private text and assets are not in the film.

## Render

Use Node.js 22 or later, Chromium, and FFmpeg. Install and render from this directory:

```bash
npm ci
npm run check
npm run render -- --video-only
```

To render the 22-second app switching video locally, use:

```bash
npm run render -- --video-only
```

This writes `out/asb-demo-app-switching.mp4`. It leaves the prior `out/asb-demo-session-switching.mp4` and the published assets unchanged. Add `--stills` to render twelve preview frames instead of the video. The completed video was also decoded to before-click, Opening, and opened-chat frames in `out/app-switching-review/`.

The default browser path is `/usr/bin/chromium`. To use another installed browser or FFmpeg path:

```bash
REMOTION_BROWSER_EXECUTABLE=/absolute/path/to/chromium FFMPEG_EXECUTABLE=/absolute/path/to/ffmpeg npm run render
```

`npm run poster` renders only the banner, video poster, and story frames. `out/` and `node_modules/` are ignored. The render uses the official [bundle](https://www.remotion.dev/docs/bundle), [renderStill](https://www.remotion.dev/docs/renderer/render-still), and [renderMedia](https://www.remotion.dev/docs/renderer/render-media) APIs. All animation uses frame numbers. There are no CSS timers or external assets at render time.

## Outputs

| File | Format |
| --- | --- |
| [Banner](../docs/media/asb-banner.png) | 1600 × 680 PNG |
| [Published demo](../docs/media/asb-demo.mp4) | 24 seconds, 1280 × 720, 30 fps, H.264, silent |
| [Published README demo](../docs/media/asb-demo.gif) | 24 seconds, 960 × 540, 12 fps, looping GIF |
| Prior local session handoff video, `out/asb-demo-session-switching.mp4` | 28.5 seconds, 1280 × 720, 30 fps, H.264, silent |
| Local app switching video, `out/asb-demo-app-switching.mp4` | 22 seconds, 1280 × 720, 30 fps, H.264, silent |
| [Video poster](../docs/media/asb-demo-poster.png) | 1280 × 720 PNG |

The GIF uses a 128-color palette to limit its download size. Use the MP4 for full motion quality. Use the static banner or poster when animation is unsuitable.

## Story

The whole film shows desktop session switching. There is no control tutorial or full-screen brand sequence.

| Click time | Result |
| --- | --- |
| 2.0 seconds | ASB opens `Atlas docs` in the Claude Code view, under `atlas`. |
| 7.2 seconds | ASB raises Codex and selects `Relay cache`, under `relay`. |
| 12.4 seconds | ASB raises Claude and selects `Orchid index`, under `orchid`. |
| 17.6 seconds | ASB raises Codex and returns to `Harbor API`, under `harbor`. |

Each click shows inline **Opening…** for 0.6 seconds. The app then comes forward with the exact chat selected in its sidebar and header. Its existing messages remain static. No prompt is typed or submitted. ASB stays reachable because it sits beside the app windows; the scene does not imply an Always on Top feature.

The ASB list uses the existing Compact row height, toolbar, sort order, and open acknowledgment rules. The sample palette stays fixed. The original app windows use the sidebar structure from the user references. A small `sample sessions · illustrated desktop` label stays visible.

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

`npm run check` proves four alternating provider and specific chat matches, their title and project, the inline opening state, the 660-frame duration, and the absence of UI tour phases. The preview frames were inspected in one batch. Final review frames and the contact sheet come from the completed MP4. FFprobe verifies format, duration, frame count, and the absence of audio. A full FFmpeg decode checks the complete video. These are media checks, not application UI tests.
