import {bundle} from '@remotion/bundler';
import {openBrowser, renderMedia, renderStill, selectComposition} from '@remotion/renderer';
import {spawnSync} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const media = path.resolve(here, '../docs/media');
const out = path.join(here, 'out');
const videoOnly = process.argv.includes('--video-only');
const videoPath = path.join(videoOnly ? out : media, videoOnly ? 'asb-demo-app-switching.mp4' : 'asb-demo.mp4');
const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || '/usr/bin/chromium';
if (!videoOnly) await mkdir(media, {recursive: true});
await mkdir(out, {recursive: true});
const serveUrl = await bundle({entryPoint: path.join(here, 'src/index.jsx'),
  publicDir: path.join(here, 'public'), outDir: path.join(out, 'bundle')});
const browser = await openBrowser('chrome', {browserExecutable});
const options = {serveUrl, browserExecutable, puppeteerInstance: browser, logLevel: 'warn'};
try {
  const film = await selectComposition({...options, id: 'ASBDemo'});
  if (!videoOnly) {
    const banner = await selectComposition({...options, id: 'ASBBanner'});
    await renderStill({...options, composition: banner, frame: 0, imageFormat: 'png',
      output: path.join(media, 'asb-banner.png')});
    await renderStill({...options, composition: film, frame: 108, imageFormat: 'png',
      output: path.join(media, 'asb-demo-poster.png')});
  }
  const storyFrames = [58, 66, 108, 214, 222, 264, 370, 378, 420, 526, 534, 588];
  if (!videoOnly || process.argv.includes('--stills')) {
    for (const frame of storyFrames) {
      await renderStill({...options, composition: film, frame, imageFormat: 'png',
        output: path.join(out, `app-frame-${String(frame).padStart(3, '0')}.png`)});
    }
  }
  if (!process.argv.includes('--stills')) {
    let lastProgress = -1;
    await renderMedia({...options, composition: film, codec: 'h264', crf: 18,
      pixelFormat: 'yuv420p', x264Preset: 'medium', concurrency: 3, imageFormat: 'png',
      outputLocation: videoPath,
      metadata: {title: 'ASB app switching', comment: 'Sample sessions. Illustrated desktop. Static existing conversation history.'},
      onProgress: ({progress}) => {
        const step = Math.floor(progress * 10);
        if (step > lastProgress) {lastProgress = step; console.log(`Video ${step * 10}%`);}
      }});
    if (!videoOnly) {
      // ponytail: 960px/12fps GIF keeps README download cost bounded; MP4 carries the full 720p/30fps film.
      const gif = spawnSync(process.env.FFMPEG_EXECUTABLE || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-i', videoPath, '-filter_complex',
        '[0:v]fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
        '-loop', '0', path.join(media, 'asb-demo.gif')], {encoding: 'utf8'});
      if (gif.status !== 0) throw new Error(gif.stderr || 'FFmpeg GIF render failed.');
    }
  }
  console.log(`Rendered assets in ${videoOnly ? out : media}`);
} finally {
  await browser.close({silent: true});
}
