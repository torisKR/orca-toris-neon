import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, buildNodePrompt } from '../src/runtime.mjs';

const NOW = Date.parse('2026-11-19T05:00:00Z');
function harness(options = {}) {
  const store = options.store || new Map();
  const receipts = new Map();
  const calls = [];
  const events = new Map();
  const agents = [];
  const workspaces = [];
  let sequence = 0;
  let terminalSequence = 0;
  let source = 'source-v1';
  let writes = 0;
  let maxWrites = 0;
  const orca = {
    storage: {
      get: async (key) => structuredClone(store.get(key) ?? null),
      set: async (key, value) => {
        writes++;
        maxWrites = Math.max(maxWrites, writes);
        await Promise.resolve();
        store.set(key, structuredClone(value));
        writes--;
      }
    },
    panels: { post() {} },
    events: { on: (name, callback) => {
      events.set(name, callback);
      return { dispose: () => events.delete(name) };
    } },
    log() {},
    host: {
      has: () => true,
      call: async (name, input = {}) => {
        calls.push({ name, input: structuredClone(input) });
        if (options.host) {
          const result = await options.host(name, input, { calls, store, agents, workspaces });
          if (result !== undefined) return result;
        }
        if (name === 'project.list') return { projects: [{ id: 'p1', name: 'App', kind: 'git', hostId: 'local', path: '/repo' }] };
        if (name === 'workspace.list') return { workspaces };
        if (name === 'workspace.readContext') return null;
        if (name === 'workspace.create') {
          workspaces.push({ id: 'w1', name: input.name, projectId: 'p1', kind: 'worktree', hostId: 'local', path: '/repo/worktree' });
          return { workspaceId: 'w1' };
        }
        if (name === 'agent.launch') {
          const saved = store.get('toris-neon.runtime.v1');
          assert.ok(saved.runs.some((run) => run.jobs.some((job) => job.state === 'launching')), 'launch intent is durable before API mutation');
          const terminalId = 't' + (++terminalSequence);
          agents.push({ terminalId, agent: input.agent, state: 'working' });
          return { terminalId };
        }
        if (name === 'agents.list') return { agents };
        if (name === 'terminal.close') {
          const agent = agents.find((item) => item.terminalId === input.terminalId);
          if (agent) agent.state = 'done';
          return { closed: true };
        }
        if (name === 'terminal.focus') return { focused: true };
        if (name === 'workspace.open') return { opened: true };
        if (name === 'statusBar.update') return { ok: true };
        throw new Error('Unexpected host API: ' + name);
      }
    }
  };
  const runtime = createRuntime({
    orca, now: () => NOW, id: () => 'id-' + (++sequence),
    receiptRoot: '/private/neon/runs',
    fingerprint: async () => source,
    ensureDirectory: async () => {},
    readReceipt: async (filename) => {
      if (!receipts.has(filename)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return structuredClone(receipts.get(filename));
    },
    validateArtifact: async (evidence, job) => {
      if (!evidence.path.startsWith(job.receiptDirectory + '/')) throw new Error('artifact escaped');
      return { ...evidence, sha256: 'artifact-hash', size: 20 };
    }
  });
  const getRun = () => runtime.getState().runs[0];
  const currentJob = () => getRun().jobs.findLast((job) => job.state === 'running' || job.state === 'awaiting-report');
  const report = (job = currentJob(), overrides = {}) => {
    const value = {
      runId: job.runId, nodeId: job.nodeId, nonce: job.nonce, phase: job.phase, attempt: job.attempt,
      outcome: 'passed', summary: '실제 단계 검증 완료',
      evidence: [{ kind: 'command', command: 'npm test', exitCode: 0 }, { kind: 'artifact', path: job.receiptDirectory + '/verification.md' }],
      ...(job.phase === 'review' ? { sourceFingerprint: job.sourceFingerprint } : {}),
      ...overrides
    };
    receipts.set(job.receiptPath, value);
    return value;
  };
  const done = async (job = currentJob(), outcome = 'success') => {
    const agent = agents.find((item) => item.terminalId === job.terminalId);
    if (agent) agent.state = 'done';
    await events.get('agent.status.changed')?.({ terminalId: job.terminalId, workspaceId: 'w1', state: 'done', sessionId: 'session-' + job.terminalId, mainAgent: { state: 'done', outcome } });
    await runtime.drain();
  };
  const create = async (nodes = [{ id: 'build', title: '앱 구현', deps: [], write: true }], extras = {}) => {
    await runtime.initialize();
    return runtime.handlers['runs.create']({ goal: '낚시 앱 제작', projectId: 'p1', nodes, ...extras });
  };
  const start = async () => {
    await runtime.handlers['runs.start']({ runId: getRun().id });
    await runtime.drain();
  };
  return { runtime, orca, store, calls, events, receipts, agents, workspaces, getRun, currentJob, report, done, create, start, source: (value) => { source = value; }, maxWrites: () => maxWrites };
}
const launchCalls = (h) => h.calls.filter((call) => call.name === 'agent.launch');

test('creates a plan without running agents; start durably claims once and creates one worktree', async () => {
  const h = harness();
  await h.create();
  assert.equal(launchCalls(h).length, 0);
  await Promise.all([h.start(), h.start()]);
  assert.equal(h.calls.filter((call) => call.name === 'workspace.create').length, 1);
  assert.equal(launchCalls(h).length, 1);
  assert.equal(h.getRun().nodes[0].attempts, 1);
  assert.equal(h.maxWrites(), 1);
});

test('work receipt launches an independent review; verified review completes the node', async () => {
  const h = harness();
  await h.create(); await h.start();
  h.report(); await h.done();
  assert.equal(h.currentJob().phase, 'review');
  assert.equal(launchCalls(h).length, 2);
  assert.match(launchCalls(h)[1].input.prompt, /독립 검토자/);
  h.report(); await h.done();
  assert.equal(h.getRun().status, 'completed');
  assert.equal(h.getRun().nodes[0].status, 'passed');
  assert.equal(h.getRun().nodes[0].receipt.artifacts[0].sha256, 'artifact-hash');
});

test('a done event without a receipt blocks; explicit refresh imports a later valid receipt', async () => {
  const h = harness();
  await h.create(); await h.start();
  const job = h.currentJob();
  await h.done(job);
  assert.equal(h.getRun().nodes[0].status, 'blocked');
  assert.equal(h.getRun().jobs[0].state, 'awaiting-report');
  assert.equal(launchCalls(h).length, 1);
  await h.runtime.handlers['runs.refresh']({ runId: h.getRun().id });
  assert.equal(launchCalls(h).length, 1);
  h.report(job);
  await h.runtime.handlers['runs.refresh']({ runId: h.getRun().id });
  await h.runtime.drain();
  assert.equal(h.currentJob().phase, 'review');
});

test('wrong nonce and attempt do not pass a task', async () => {
  for (const override of [{ nonce: 'stale' }, { attempt: 999 }]) {
    const h = harness();
    await h.create(); await h.start();
    h.report(undefined, override); await h.done();
    assert.equal(h.getRun().nodes[0].status, 'blocked');
    assert.equal(launchCalls(h).length, 1);
  }
});

test('passed receipt needs an actual artifact in addition to a reported command', async () => {
  const h = harness();
  await h.create(); await h.start();
  h.report(undefined, { evidence: [{ kind: 'command', command: 'npm test', exitCode: 0 }] });
  await h.done();
  assert.equal(h.getRun().nodes[0].status, 'blocked');
  assert.match(h.getRun().nodes[0].failureReason, /artifact/);
});

test('source changes during independent review invalidate its passing receipt', async () => {
  const h = harness();
  await h.create(); await h.start();
  h.report(); await h.done();
  h.report(); h.source('source-v2'); await h.done();
  assert.equal(h.getRun().nodes[0].status, 'blocked');
  assert.match(h.getRun().nodes[0].failureReason, /소스가 변경/);
});

test('pause preserves active workers, accepts their reports and does not launch the review', async () => {
  const h = harness();
  await h.create(); await h.start();
  await h.runtime.handlers['runs.pause']({ runId: h.getRun().id });
  assert.equal(h.calls.filter((call) => call.name === 'terminal.close').length, 0);
  h.report(); await h.done();
  assert.equal(h.getRun().status, 'paused');
  assert.equal(h.getRun().nodes[0].status, 'review');
  assert.equal(launchCalls(h).length, 1);
  await h.runtime.handlers['runs.resume']({ runId: h.getRun().id });
  await h.runtime.drain();
  assert.equal(launchCalls(h).length, 2);
});

test('paused failed work keeps retry pending without resuming itself', async () => {
  const h = harness();
  await h.create(); await h.start();
  await h.runtime.handlers['runs.pause']({ runId: h.getRun().id });
  h.report(undefined, { outcome: 'failed', summary: '빌드 오류', evidence: [{ kind: 'command', command: 'npm test', exitCode: 1 }] });
  await h.done(undefined, 'failure');
  assert.equal(h.getRun().status, 'paused');
  assert.equal(h.getRun().nodes[0].status, 'pending');
  assert.equal(launchCalls(h).length, 1);
});

test('an ambiguous launch failure is persisted and never retried by refresh or resume', async () => {
  const h = harness({ host: async (name) => {
    if (name === 'agent.launch') throw Object.assign(new Error('response timeout'), { code: 'timeout' });
  } });
  await h.create(); await h.start();
  assert.equal(h.getRun().nodes[0].status, 'blocked');
  assert.equal(h.getRun().jobs[0].state, 'uncertain');
  await h.runtime.handlers['runs.refresh']({ runId: h.getRun().id });
  await h.runtime.handlers['runs.resume']({ runId: h.getRun().id });
  await h.runtime.drain();
  assert.equal(launchCalls(h).length, 1);
  await assert.rejects(h.runtime.handlers['nodes.retry']({ runId: h.getRun().id, nodeId: 'build' }), /불명확/);
});

test('restart preserves active ownership and pauses scheduling instead of duplicating launch', async () => {
  const h = harness();
  await h.create(); await h.start();
  h.runtime.dispose();
  const restarted = createRuntime({
    orca: h.orca, now: () => NOW, ensureDirectory: async () => {}, fingerprint: async () => 'source-v1'
  });
  await restarted.initialize();
  await restarted.drain();
  assert.equal(launchCalls(h).length, 1);
  assert.equal(restarted.getState().runs[0].status, 'paused');
  assert.equal(restarted.getState().runs[0].nodes[0].active.terminalId, 't1');
  restarted.dispose();
});

test('cancel closes owned terminals only and reports any failed stop', async () => {
  const h = harness({ host: async (name) => {
    if (name === 'terminal.close') throw Object.assign(new Error('host unavailable'), { code: 'unavailable' });
  } });
  await h.create(); await h.start();
  h.agents.push({ terminalId: 'unrelated', state: 'working' });
  await h.runtime.handlers['runs.cancel']({ runId: h.getRun().id });
  assert.equal(h.getRun().status, 'cancelled');
  assert.equal(h.getRun().stopFailures.length, 1);
  assert.deepEqual(h.calls.filter((call) => call.name === 'terminal.close').map((call) => call.input.terminalId), ['t1']);
});

test('read-only graph nodes run together while writes wait for a stable exclusive source window', async () => {
  const h = harness();
  await h.create([
    { id: 'research', title: '조사', deps: [], write: false },
    { id: 'design', title: '설계', deps: [], write: false },
    { id: 'build', title: '구현', deps: [], write: true },
    { id: 'assets', title: '에셋', deps: [], write: true }
  ], { maxConcurrency: 4 });
  await h.start();
  assert.equal(launchCalls(h).length, 2);
  assert.equal(h.getRun().nodes.filter((node) => node.active && node.write).length, 0);
});

test('remote project is rejected before workspace creation or launch', async () => {
  const h = harness({ host: async (name) => {
    if (name === 'project.list') return { projects: [{ id: 'p1', kind: 'git', hostId: 'ssh:remote' }] };
  } });
  await h.create();
  await assert.rejects(h.start(), /로컬/);
  assert.equal(h.calls.filter((call) => call.name === 'workspace.create').length, 0);
  assert.equal(launchCalls(h).length, 0);
});

test('unsafe workspace path and arbitrary terminal focus are rejected', async () => {
  const h = harness();
  await h.create();
  await assert.rejects(h.runtime.handlers['terminals.focus']({ terminalId: 'foreign' }), /배정한 터미널/);
  await assert.rejects(h.runtime.handlers['workspace.open']({ workspaceId: 'foreign' }), /찾을 수 없습니다/);
});

test('a plan in an existing workspace cannot be launched by unrelated agent events', async () => {
  const h = harness();
  await h.create(); await h.start();
  const planned = await h.runtime.handlers['runs.create']({
    goal: '나중에 시작할 앱', projectId: 'p1', isolate: false, workspaceId: 'w1',
    nodes: [{ id: 'build', title: '구현', deps: [], write: true }]
  });
  assert.equal(planned.started, false);
  await h.events.get('agent.status.changed')({ terminalId: 'unrelated', state: 'working' });
  await h.runtime.drain();
  assert.equal(launchCalls(h).length, 1);
});

test('ambiguous launch freezes a run even when another terminal is still working', async () => {
  let count = 0;
  const h = harness({ host: async (name) => {
    if (name === 'agent.launch' && ++count === 2) throw Object.assign(new Error('response timeout'), { code: 'timeout' });
  } });
  await h.create([
    { id: 'one', title: '하나', deps: [], write: false },
    { id: 'two', title: '둘', deps: [], write: false },
    { id: 'three', title: '셋', deps: [], write: false }
  ], { maxConcurrency: 2 });
  await h.start();
  assert.equal(launchCalls(h).length, 2);
  await h.events.get('agent.status.changed')({ terminalId: 't1', state: 'working' });
  await h.runtime.drain();
  assert.equal(launchCalls(h).length, 2);
  assert.equal(h.getRun().nodes.find((node) => node.id === 'three').attempts, 0);
});

test('a failed assignment request is atomic instead of keeping earlier edits', async () => {
  const h = harness();
  await h.create();
  await assert.rejects(h.runtime.handlers['runs.updateAssignments']({
    runId: h.getRun().id, assignments: { build: { agent: 'grok' }, missing: { agent: 'cursor' } }
  }), /단계가 없습니다/);
  assert.equal(h.getRun().nodes[0].agent, 'codex');
});

test('exhausted retry preserves the receipt waiting for explicit reconciliation', async () => {
  const h = harness();
  await h.create(undefined, { maxAttempts: 1 }); await h.start();
  const job = h.currentJob();
  await h.done();
  const before = h.runtime.getState();
  await assert.rejects(h.runtime.handlers['nodes.retry']({ runId: h.getRun().id, nodeId: 'build' }), /한도/);
  assert.deepEqual(h.runtime.getState(), before);
  h.report(job);
  await h.runtime.handlers['runs.refresh']({ runId: h.getRun().id });
  await h.runtime.drain();
  assert.equal(h.currentJob().phase, 'review');
});

test('submission gates require a concrete package, track, version and an explicit approval note', async () => {
  const h = harness();
  await h.create([{ id: 'release', title: '출시 검토', deps: [], write: true }]);
  await h.start();
  assert.equal(launchCalls(h).length, 0);
  await assert.rejects(h.runtime.handlers['runs.approve']({
    runId: h.getRun().id, nodeId: 'release',
    submission: { packageName: 'com.toris.app', track: 'production', versionCode: 42 }
  }), /승인 메모/);
  await assert.rejects(h.runtime.handlers['runs.approve']({
    runId: h.getRun().id, nodeId: 'release', note: '실제 앱의 테스트와 버전을 확인한 뒤 제출 승인',
    submission: { packageName: 'com.toris.app', track: 'internal', versionCode: 42 }
  }), /production/);
  await h.runtime.handlers['runs.approve']({
    runId: h.getRun().id, nodeId: 'release', note: 'com.toris.app production 42 제출 승인',
    submission: { packageName: 'com.toris.app', track: 'production', versionCode: 42 }
  });
  await h.runtime.drain();
  assert.equal(launchCalls(h).length, 1);
  assert.match(launchCalls(h)[0].input.prompt, /"versionCode":"42"/);
  assert.match(launchCalls(h)[0].input.prompt, /이 대상만 제출/);
  assert.equal(h.getRun().nodes[0].approval.sourceFingerprint, 'source-v1');
});

test('source drift after concrete submission approval prevents agent launch without an ambiguous intent', async () => {
  const h = harness();
  await h.create([{ id: 'release', title: '출시 검토', deps: [], write: true }]);
  await h.start();
  await h.runtime.handlers['runs.pause']({ runId: h.getRun().id });
  await h.runtime.handlers['runs.approve']({
    runId: h.getRun().id, nodeId: 'release', note: 'com.toris.app production 42 제출 승인',
    submission: { packageName: 'com.toris.app', track: 'production', versionCode: 42 }
  });
  h.source('source-changed');
  await h.runtime.handlers['runs.resume']({ runId: h.getRun().id });
  await h.runtime.drain();
  assert.equal(launchCalls(h).length, 0);
  assert.equal(h.getRun().nodes[0].status, 'blocked');
  assert.equal(h.getRun().jobs[0].state, 'not-started');
  assert.equal(h.getRun().nodes[0].launchUncertain, undefined);
});

test('approval without a submission target runs preparation only', async () => {
  const h = harness();
  await h.create([{ id: 'internal', title: '내부 테스트 준비', deps: [], write: true }]);
  await h.start();
  await h.runtime.handlers['runs.approve']({ runId: h.getRun().id, nodeId: 'internal' });
  await h.runtime.drain();
  assert.equal(launchCalls(h).length, 1);
  assert.match(launchCalls(h)[0].input.prompt, /실제 앱 스토어 제출\/배포는 하지 마세요/);
});

test('uncertain workspace creation can attach a verified local workspace without launching', async () => {
  const h = harness({ host: async (name) => {
    if (name === 'workspace.create') throw Object.assign(new Error('response timeout'), { code: 'timeout' });
  } });
  await h.create();
  await assert.rejects(h.start(), /timeout/);
  const runId = h.getRun().id;
  h.workspaces.push({ id: 'recovered', name: 'Created before timeout', projectId: 'p1', kind: 'worktree', hostId: 'local', path: '/repo/recovered' });
  const attached = await h.runtime.handlers['runs.attachWorkspace']({ runId, workspaceId: 'recovered' });
  assert.equal(attached.workspaceId, 'recovered');
  assert.equal(attached.workspacePath, '/repo/recovered');
  assert.equal(attached.workspaceCreation.state, 'created');
  assert.equal(attached.status, 'paused');
  assert.equal(attached.started, false);
  await h.events.get('agent.status.changed')({ terminalId: 'unrelated', state: 'done' });
  await h.runtime.drain();
  assert.equal(launchCalls(h).length, 0);
  assert.equal(h.calls.filter((call) => call.name === 'workspace.create').length, 1);
});

test('invalid recovery attachments preserve all existing state atomically', async () => {
  const h = harness({ host: async (name) => {
    if (name === 'workspace.create') throw Object.assign(new Error('response timeout'), { code: 'timeout' });
  } });
  await h.create();
  await assert.rejects(h.start(), /timeout/);
  h.workspaces.push(
    { id: 'wrong-project', name: 'Elsewhere', projectId: 'other', hostId: 'local', path: '/other' },
    { id: 'remote', name: 'Remote', projectId: 'p1', hostId: 'ssh:remote', path: '/remote' },
    { id: 'relative', name: 'Invalid path', projectId: 'p1', hostId: 'local', path: 'relative' }
  );
  for (const workspaceId of ['unknown', 'wrong-project', 'remote', 'relative']) {
    const before = h.runtime.getState();
    await assert.rejects(h.runtime.handlers['runs.attachWorkspace']({ runId: h.getRun().id, workspaceId }));
    assert.deepEqual(h.runtime.getState(), before);
  }
});

test('normal plans and already-started runs cannot attach another workspace', async () => {
  const h = harness();
  await h.create();
  await assert.rejects(h.runtime.handlers['runs.attachWorkspace']({ runId: h.getRun().id, workspaceId: 'anything' }), /불명확/);
  await h.start();
  const before = h.runtime.getState();
  await assert.rejects(h.runtime.handlers['runs.attachWorkspace']({ runId: h.getRun().id, workspaceId: 'w1' }), /불명확/);
  assert.deepEqual(h.runtime.getState(), before);
});

test('archive rejects active or unconfirmed stopped runs and preserves them', async () => {
  const h = harness({ host: async (name) => {
    if (name === 'terminal.close') throw new Error('Unable to stop terminal');
  } });
  await h.create(); await h.start();
  const runId = h.getRun().id;
  let before = h.runtime.getState();
  await assert.rejects(h.runtime.handlers['runs.archive']({ runId }), /완료 또는 취소/);
  assert.deepEqual(h.runtime.getState(), before);
  await h.runtime.handlers['runs.cancel']({ runId });
  before = h.runtime.getState();
  await assert.rejects(h.runtime.handlers['runs.archive']({ runId }), /종료 오류/);
  assert.deepEqual(h.runtime.getState(), before);
});

test('archive moves a completed record without losing dates, receipts or event history', async () => {
  const h = harness();
  await h.create(); await h.start();
  h.report(); await h.done();
  h.report(); await h.done();
  const completed = h.getRun();
  const result = await h.runtime.handlers['runs.archive']({ runId: completed.id });
  assert.equal(result.archived, true);
  assert.equal(h.runtime.getState().runs.length, 0);
  const archived = h.runtime.getState().archivedRuns[0];
  assert.equal(archived.id, completed.id);
  assert.equal(archived.createdAt, completed.createdAt);
  assert.equal(archived.status, 'completed');
  assert.deepEqual(archived.nodes, completed.nodes);
  assert.deepEqual(archived.events.slice(0, completed.events.length), completed.events);
  assert.equal(archived.archivedAt, new Date(NOW).toISOString());
  assert.equal(h.store.get('toris-neon.runtime.v1').archivedRuns[0].id, completed.id);
  await assert.rejects(h.runtime.handlers['runs.start']({ runId: completed.id }), /찾을 수 없습니다/);
});

test('a cleanly cancelled plan can be archived to free an active-run slot', async () => {
  const h = harness();
  await h.create();
  const runId = h.getRun().id;
  await h.runtime.handlers['runs.cancel']({ runId });
  await h.runtime.handlers['runs.archive']({ runId });
  assert.equal(h.runtime.getState().runs.length, 0);
  assert.equal(h.runtime.getState().archivedRuns[0].status, 'cancelled');
});

test('the task prompt contains nonce-scoped receipt, prior feedback and local instructions', () => {
  const run = { id: 'r', goal: '앱 제작', workspacePath: '/repo', nodes: [] };
  const node = { id: 'test', title: '검증', role: 'qa', deps: [], write: false, feedback: { summary: '수정할 버그' } };
  const job = { runId: 'r', nodeId: 'test', nonce: 'nonce', phase: 'work', attempt: 1, agent: 'codex', receiptDirectory: '/private/r', receiptPath: '/private/r/result.json' };
  const prompt = buildNodePrompt(run, node, job);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /수정할 버그/);
  assert.match(prompt, /"nonce": "nonce"/);
  assert.match(prompt, /실제로 실행하지 않은/);
});
