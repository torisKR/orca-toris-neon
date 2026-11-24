import test from 'node:test';
import assert from 'node:assert/strict';
import { RELEASE_STAGES as PANEL_RELEASE } from '../panel/runplan.mjs';
import { RELEASE_STAGES } from '../src/scope.mjs';

test('the panel names the same release stages as the worker', () => {
  assert.deepEqual([...PANEL_RELEASE], [...RELEASE_STAGES]);
});

test('the panel names the same profiles and build fan-out as the worker', async () => {
  const panel = await import('../panel/runplan.mjs');
  const worker = await import('../src/profile.mjs');
  assert.deepEqual(panel.PROFILE_CHOICES.map(([id]) => id), [...worker.PROFILES]);
  assert.deepEqual(Object.fromEntries(panel.PROFILE_CHOICES.map(([id, name]) => [id, name])), { ...worker.PROFILE_NAMES });
  for (const id of worker.PROFILES) assert.equal(panel.FANOUT[id], worker.fanoutOf({ profile: id }), id);
});
