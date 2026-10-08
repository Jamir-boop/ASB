import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FRAMES, FPS, samples, conversations, switches, storyAt} from './story.mjs';

test('four clicks select the exact existing chat in alternating original apps', () => {
  assert.equal(FRAMES / FPS, 22);
  assert.equal(new Set(samples.map(row => row.id)).size, samples.length);
  assert.deepEqual(switches.map(action => action.id), ['atlas', 'relay', 'orchid', 'harbor']);
  for (const [index, [id, provider, title, folder]] of [
    ['atlas', 'claude', 'Atlas docs', 'atlas'],
    ['relay', 'codex', 'Relay cache', 'relay'],
    ['orchid', 'claude', 'Orchid index', 'orchid'],
    ['harbor', 'codex', 'Harbor API', 'harbor'],
  ].entries()) {
    const action = switches[index];
    const before = storyAt(action.click - 1);
    assert.notEqual(before.apps[provider].id, id);
    const opening = storyAt(action.click);
    assert.equal(opening.opening, true);
    assert.equal(opening.selected, id);
    assert.equal(opening.activeApp, 'ASB');
    for (let frame = action.opened; frame < (switches[index + 1]?.click ?? FRAMES); frame++) {
      const story = storyAt(frame);
      assert.equal(story.focusedProvider, provider);
      assert.deepEqual([story.apps[provider].id, story.apps[provider].provider,
        story.apps[provider].title, story.apps[provider].folder], [id, provider, title, folder]);
      assert.equal(story.selected, id);
      assert(conversations[id].request && conversations[id].response && conversations[id].result);
    }
  }
  for (let frame = 0; frame < FRAMES; frame++) {
    const {phase, rows} = storyAt(frame);
    assert.equal(phase, 'desktop');
    assert.equal(new Set(rows.map(row => row.id)).size, samples.length);
    assert(rows.every(row => ['Working', 'Idle', 'Waiting', 'Unknown'].includes(row.state)));
    assert.equal(rows.find(row => row.id === 'relay').pending, false);
  }
});
