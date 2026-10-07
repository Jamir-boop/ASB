import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FRAMES, FPS, samples, rowsAt, storyAt, menuActions} from './story.mjs';

test('the demo preserves ASB state, attention, search, pin and Read rules', () => {
  assert.equal(FRAMES / FPS, 24);
  assert.equal(new Set(samples.map(row => row.id)).size, samples.length);
  const workingDot = rowsAt(180).find(row => row.id === 'relay');
  assert.equal(workingDot.state, 'Working');
  assert.equal(workingDot.unread, true);
  assert.equal(workingDot.pending, false);
  assert.deepEqual(menuActions(workingDot), ['Read', 'Pin']);
  assert.deepEqual(menuActions(rowsAt(615)[0]), ['Read', 'Unpin']);
  assert(!rowsAt(180, {pending: true}).some(row => row.id === 'relay'));
  assert(rowsAt(380, {query: 'cl: docs'}).every(row => row.provider === 'claude'));
  assert.equal(rowsAt(410, {query: 'cx: relay'})[0].id, 'relay');
  assert.equal(rowsAt(550)[0].id, 'relay');
  const read = rowsAt(615).find(row => row.id === 'atlas');
  assert.equal(read.state, 'Idle');
  assert.equal(read.unread, false);
  assert.deepEqual(menuActions(read), ['Unread', 'Pin']);
  assert.equal(storyAt(470).pending, true);
  for (let frame = 0; frame < FRAMES; frame++) {
    const {rows} = storyAt(frame);
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
    assert(rows.every(row => ['Working', 'Idle', 'Waiting', 'Unknown'].includes(row.state)));
  }
});
