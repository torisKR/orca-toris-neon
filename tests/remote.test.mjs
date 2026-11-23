import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteControl, REMOTE_HELP } from '../src/remote.mjs';

/** A fake Neon: runs.create dedupes on the exact requestId of a run that is not cancelled, like src/runtime.mjs. */
function harness({ runs = [], failCreate } = {}) {
  const state = { runs: structuredClone(runs), created: 0, failed: 0, starts: [], resumes: [] };
  const find = (runId) => state.runs.find((run) => run.id === runId);
  const remote = createRemoteControl({
    getRuns: () => structuredClone(state.runs),
    createRun: async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 5)); // let concurrent requests interleave
      if (failCreate && !state.failed++) throw Object.assign(new Error(failCreate), { code: 'invalid_params' });
      const key = 'req:' + input.requestId;
      const existing = state.runs.find((run) => run.requestId === key && run.status !== 'cancelled');
      if (existing) return structuredClone(existing);
      state.created += 1;
      const run = { id: 'run-' + state.created, requestId: key, goal: input.goal ?? '프로젝트 진단', projectId: input.projectId ?? 'p-parent', template: input.template, status: 'ready', started: false,
        updatedAt: '2026-11-23T00:00:0' + state.created + '.000Z', parentRunId: input.parentRunId, improvement: input.kind ? { kind: input.kind } : undefined,
        nodes: [{ id: 'build', write: true, status: 'pending' }, { id: 'test', status: 'pending' }] };
      state.runs.push(run);
      return structuredClone(run);
    },
    startRun: async ({ runId }) => { state.starts.push(runId); Object.assign(find(runId), { started: true, status: 'running' }); return structuredClone(find(runId)); },
    resumeRun: async ({ runId }) => { state.resumes.push(runId); Object.assign(find(runId), { status: 'running' }); return structuredClone(find(runId)); }
  });
  return { state, request: remote.request };
}
const create = (extra = {}) => ({ action: 'create', requestId: 'bot-42', mode: 'new-app', projectId: 'p1', goal: '물주기 알림 앱', ...extra });

test('the same requestId with the same content returns the run it already made', async () => {
  // Arrange
  const h = harness();

  // Act
  const first = await h.request(create());
  const again = await h.request(create({ goal: '  물주기 알림 앱 ' }));

  // Assert
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.run.runId, first.run.runId);
  assert.equal(again.run.requestId, 'bot-42', 'the caller sees its own id, not the internal key');
  assert.equal(h.state.created, 1);
});

test('the same requestId with different content is a conflict that names the existing run', async () => {
  // Arrange
  const h = harness();
  const first = await h.request(create());

  // Act
  const conflict = h.request(create({ goal: '다른 앱' }));

  // Assert
  await assert.rejects(conflict, (error) => error.code === 'conflict' && error.message.startsWith('[conflict] ') && error.message.includes(first.run.runId));
  await assert.rejects(h.request(create({ projectId: 'p2' })), { code: 'conflict' });
  await assert.rejects(h.request(create({ mode: 'improve', kind: 'bugfix' })), { code: 'conflict' });
  assert.equal(h.state.created, 1);
});

test('the same goal under a different requestId is a new run: goal text alone never dedupes', async () => {
  // Arrange
  const h = harness();

  // Act
  const a = await h.request(create({ requestId: 'bot-1' }));
  const b = await h.request(create({ requestId: 'bot-2' }));

  // Assert
  assert.notEqual(a.run.runId, b.run.runId);
  assert.equal(h.state.created, 2);
});

test('concurrent deliveries of one request make one run, and a concurrent different one conflicts', async () => {
  // Arrange
  const h = harness();

  // Act
  const results = await Promise.allSettled([h.request(create()), h.request(create()), h.request(create({ goal: '다른 앱' }))]);

  // Assert
  assert.equal(h.state.created, 1);
  assert.equal(results[0].value.run.runId, results[1].value.run.runId);
  assert.equal(results[2].reason.code, 'conflict');
});

test('a redelivered request for a cancelled run returns that run instead of starting the work again', async () => {
  // Arrange
  const h = harness();
  const first = await h.request(create());
  h.state.runs[0].status = 'cancelled';

  // Act
  const again = await h.request(create());

  // Assert
  assert.equal(again.run.runId, first.run.runId);
  assert.equal(again.run.status, 'cancelled');
  assert.equal(h.state.created, 1);
});

test('a refused creation leaves nothing behind, so a corrected request with the same id is accepted', async () => {
  // Arrange
  const h = harness({ failCreate: '프로젝트에 커밋이 없습니다.' });

  // Act
  const refused = h.request(create());

  // Assert
  await assert.rejects(refused, /커밋이 없습니다/);
  assert.equal(h.state.runs.length, 0);
  assert.equal((await h.request(create({ goal: '고친 목표' }))).created, true);
});

test('inspect by requestId or runId reports status and what actually finished', async () => {
  // Arrange
  const h = harness();
  const { run } = await h.request(create());
  Object.assign(h.state.runs[0].nodes[0], { status: 'passed' });

  // Act
  const byRequest = await h.request({ action: 'get', requestId: 'bot-42' });
  const byRun = await h.request({ action: 'get', runId: run.runId });

  // Assert
  assert.deepEqual(byRequest, byRun);
  assert.equal(byRequest.run.finishedText, '구현 완료 · 검증 안 됨');
  assert.deepEqual(byRequest.run.stages, { passed: 1, total: 2 });
  await assert.rejects(h.request({ action: 'get', requestId: 'nobody' }), { code: 'not_found' });
});

test('resume starts a run that never started, resumes a started one, and refuses a stale revision', async () => {
  // Arrange
  const h = harness();
  const { run } = await h.request(create());

  // Act
  await assert.rejects(h.request({ action: 'resume', runId: run.runId, expectedRevision: 'old' }), { code: 'conflict' });
  const started = await h.request({ action: 'resume', requestId: 'bot-42', expectedRevision: run.revision });
  const resumed = await h.request({ action: 'resume', runId: run.runId });

  // Assert
  assert.deepEqual(h.state.starts, [run.runId]);
  assert.deepEqual(h.state.resumes, [run.runId]);
  assert.equal(started.run.status, 'running');
  assert.equal(resumed.run.status, 'running');
  assert.deepEqual([started.action, resumed.action], ['started', 'resumed']);
  await assert.rejects(h.request({ action: 'resume', runId: run.runId, expectedRevision: 7 }), { code: 'invalid_params' });
});

test('a finished run is not resumed, and runtime refusals reach the caller with their code in the message', async () => {
  // Arrange
  const h = harness({ failCreate: '최대 40개 실행을 보관합니다.' });
  await assert.rejects(h.request(create()), (error) => error.message === '[invalid_params] 최대 40개 실행을 보관합니다.');
  const { run } = await h.request(create());
  h.state.runs[0].status = 'completed';

  // Act
  const finished = h.request({ action: 'resume', runId: run.runId });

  // Assert
  await assert.rejects(finished, (error) => error.code === 'conflict' && error.message.startsWith('[conflict] '));
  assert.deepEqual([h.state.starts, h.state.resumes], [[], []]);
});

test('follow-up makes an improvement linked to the earlier run in its project, deduped like create', async () => {
  // Arrange
  const h = harness({ runs: [{ id: 'done-1', projectId: 'p-parent', status: 'completed', template: 'new-app', goal: '앱', nodes: [] }] });
  const input = { action: 'followUp', requestId: 'bot-7', parentRunId: 'done-1', kind: 'design', goal: '홈 화면 다듬기' };

  // Act
  const first = await h.request(input);
  const again = await h.request(input);

  // Assert
  assert.equal(first.run.parentRunId, 'done-1');
  assert.equal(first.run.template, 'improve');
  assert.equal(again.run.runId, first.run.runId);
  await assert.rejects(h.request({ ...input, kind: 'bugfix' }), { code: 'conflict' });
  await assert.rejects(h.request({ ...input, requestId: 'bot-8', parentRunId: 'missing' }), { code: 'invalid_params' });
});

test('malformed requests are refused before anything is created', async () => {
  // Arrange
  const h = harness();

  // Act + Assert
  await assert.rejects(h.request(create({ requestId: undefined })), { code: 'invalid_params' });
  await assert.rejects(h.request(create({ requestId: 'has space' })), { code: 'invalid_params' });
  await assert.rejects(h.request(create({ requestId: 'x'.repeat(71) })), { code: 'invalid_params' });
  await assert.rejects(h.request(create({ mode: 'deploy' })), { code: 'invalid_params' });
  await assert.rejects(h.request(create({ mode: 'improve' })), { code: 'invalid_params' }, 'an improvement names its kind');
  await assert.rejects(h.request(create({ autonomous: false })), { code: 'invalid_params' }, 'unknown fields are refused, not ignored');
  await assert.rejects(h.request({ action: 'delete', requestId: 'bot-1' }), { code: 'invalid_params' });
  assert.equal(h.state.created, 0);
});

test('no arguments (the command palette) returns the help text instead of failing', async () => {
  // Arrange
  const h = harness();

  // Act
  const help = await h.request(undefined);

  // Assert
  assert.equal(help, REMOTE_HELP);
  assert.equal(await h.request({}), REMOTE_HELP, 'the panel bridge sends {} for no input');
  assert.match(REMOTE_HELP, /requestId/);
});

test('a requestId with dots is matched exactly, and a key without a real fingerprint is not taken for a remote request', async () => {
  // Arrange
  const h = harness({ runs: [{ id: 'forged', requestId: 'req:remote.bot-9.not-a-fingerprint', status: 'ready', nodes: [] }] });

  // Act
  const dotted = await h.request(create({ requestId: 'a.b' }));
  const prefix = await h.request(create({ requestId: 'a' }));
  const nine = await h.request(create({ requestId: 'bot-9' }));

  // Assert
  assert.notEqual(prefix.run.runId, dotted.run.runId);
  assert.equal((await h.request({ action: 'get', requestId: 'a.b' })).run.runId, dotted.run.runId);
  assert.equal(nine.created, true);
});

test('a follow-up redelivered after its parent was pruned returns the run it made', async () => {
  // Arrange
  const h = harness({ runs: [{ id: 'done-1', projectId: 'p-parent', status: 'completed', template: 'new-app', goal: '앱', nodes: [] }] });
  const input = { action: 'followUp', requestId: 'bot-7', parentRunId: 'done-1', kind: 'design', goal: '홈 화면 다듬기' };
  const first = await h.request(input);
  h.state.runs = h.state.runs.filter((run) => run.id !== 'done-1');

  // Act
  const again = await h.request(input);

  // Assert
  assert.equal(again.created, false);
  assert.equal(again.run.runId, first.run.runId);
});
