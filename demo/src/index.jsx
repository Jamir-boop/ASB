import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {Banner, Film} from './Film';
import {FPS, FRAMES} from './story.mjs';

registerRoot(() => <>
  <Composition id="ASBDemo" component={Film} width={1280} height={720}
    fps={FPS} durationInFrames={FRAMES} />
  <Composition id="ASBBanner" component={Banner} width={1600} height={680}
    fps={FPS} durationInFrames={1} />
</>);
