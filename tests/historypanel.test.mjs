import test from 'node:test';
import assert from 'node:assert/strict';
import { exportControls, exportHistory } from '../panel/history.mjs';

test('a finished run offers an export button; an unknown repository visibility asks for an explicit confirmation', () => {
  // Act
  const plain = exportControls('run-1', null);
  const asking = exportControls('run-1', { runId: 'run-1', message: '공개 여부를 확인하지 못했습니다(gh가 설치돼 있지 않습니다).' });
  // Assert
  assert.match(plain, /data-action="export-history"[^>]*data-run="run-1"/);
  assert.doesNotMatch(plain, /data-confirm/);
  assert.match(asking, /role="alert"[^>]*>[\s\S]*gh가 설치돼 있지 않습니다/);
  assert.match(asking, /data-action="export-history"[^>]*data-confirm="true"/);
  assert.doesNotMatch(exportControls('run-2', { runId: 'run-1', message: 'x' }), /role="alert"/, 'the question belongs to its own run');
});

test('the export reports where the snapshot went, turns a confirmation refusal into a question, and passes other errors on', async () => {
  // Arrange
  const calls = [];
  const ok = async (name, input) => { calls.push([name, input]); return { folder: '/Users/me/Sync/neon', exportedAt: '2026-11-24T05:00:00.000Z', visibility: 'private', exported: [{ runId: 'run-1', thumbnails: 2 }], skipped: [] }; };
  const asks = async () => { throw new Error('[confirmation_required] 공개 여부를 확인하지 못했습니다(gh가 설치돼 있지 않습니다).'); };
  const refuses = async () => { throw new Error('[public_repository] 공개 저장소 안에 있습니다.'); };
  // Act
  const done = await exportHistory({ runId: 'run-1', confirm: true, request: ok });
  const question = await exportHistory({ runId: 'run-1', confirm: false, request: asks });
  // Assert
  assert.deepEqual(calls, [['history.export', { runIds: ['run-1'], confirmUnknownVisibility: true }]]);
  assert.equal(done.pending, null);
  assert.match(done.message, /스냅샷.*\/Users\/me\/Sync\/neon\/run-1/);
  assert.deepEqual(question.pending, { runId: 'run-1', message: '공개 여부를 확인하지 못했습니다(gh가 설치돼 있지 않습니다).' });
  await assert.rejects(exportHistory({ runId: 'run-1', confirm: false, request: refuses }), /공개 저장소/);
});
