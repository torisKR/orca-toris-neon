import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, buildNodePrompt } from '../src/runtime.mjs';

const NOW = Date.parse('2026-11-19T05:00:00Z');
function assertJsonValue(value, location = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') return assert.ok(Number.isFinite(value), location + ': finite number required');
  assert.equal(typeof value, 'object', location + ': Orca requires JSON, including optional own properties');
  for (const [key, item] of Object.entries(value)) assertJsonValue(item, location + '.' + key);
}
function harness(options = {}) {
  const store = options.store || new Map();
  const receipts = new Map();
  const calls = [];
  const events = new Map();
  const agents = [];
  const workspaces = [];
  let sequence = 0;
  let terminalSequence = 0;
  let focusedTerminalId = null;
  let source = 'source-v1';
  let writes = 0;
  let maxWrites = 0;
  const orca = {
    storage: {
      get: async (key) => structuredClone(store.get(key) ?? null),
      set: async (key, value) => {
        assertJsonValue(value);
        writes++;
        maxWrites = Math.max(maxWrites, writes);
        await Promise.resolve();
        store.set(key, structuredClone(value));
        writes--;
      }
    },
    panels: { post(_name, value) { assertJsonValue(value); } },
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
          if (result !== undefined) {
            if (name === 'terminal.focus' && result?.focused === true) focusedTerminalId = input.terminalId;
            return result;
          }
        }
        if (name === 'project.list') return { projects: [{ id: 'p1', name: 'App', kind: 'git', hostId: 'local', path: '/repo' }] };
        if (name === 'workspace.list') return { workspaces };
        if (name === 'workspace.readContext') return focusedTerminalId ? { workspaceId: 'w1', branch: 'main', displayName: 'Test', terminals: [{ id: focusedTerminalId }] } : null;
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
        if (name === 'terminal.sendText') return { accepted: true };
        if (name === 'terminal.focus') { focusedTerminalId = input.terminalId; return { focused: true }; }
        if (name === 'workspace.open') return { opened: true };
        if (name === 'statusBar.update') return { ok: true };
        throw new Error('Unexpected host API: ' + name);
      }
    }
  };
  const runtime = createRuntime({
    orca, now: () => NOW, id: () => 'id-' + (++sequence), sleep: options.sleep || (async () => {}),
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

test('native-style events with omitted optional fields stay valid at strict JSON boundaries', async () => {
  const h = harness();
  const created = await h.create();
  assertJsonValue(created);
  assert.equal(Object.hasOwn(created, 'baseBranch'), false);
  await h.start();
  await h.events.get('agent.status.changed')({ terminalId: 't1', state: 'working' });
  await h.runtime.drain();
  let snapshot = await h.runtime.handlers['state.get']();
  assertJsonValue(snapshot);
  assert.equal(Object.hasOwn(snapshot.runs[0].jobs[0], 'agentOutcome'), false);
  assert.equal(snapshot.runs[0].jobs[0].terminalId, 't1');
  assert.equal(h.store.get('toris-neon.runtime.v1').runs[0].jobs[0].terminalId, 't1');
  // A done event is also valid without mainAgent, outcome or sessionId.
  h.report();
  h.agents[0].state = 'done';
  await h.events.get('agent.status.changed')({ terminalId: 't1', state: 'done' });
  await h.runtime.drain();
  snapshot = await h.runtime.handlers['state.get']();
  assertJsonValue(snapshot);
  assert.equal(snapshot.runs[0].jobs[0].state, 'complete');
  assert.equal(h.currentJob().phase, 'review');
  assert.equal(launchCalls(h).length, 2);
});

test('state RPC normalizes optional host metadata without dropping false, zero or null', async () => {
  const h = harness({ host: async (name) => {
    if (name === 'project.list') return { projects: [{ id: 'p1', name: undefined, hidden: false, count: 0, hostId: null }] };
    if (name === 'workspace.readContext') return { workspaceId: undefined, branch: 'main', terminals: [{ id: 't0', title: undefined }] };
  } });
  await h.runtime.initialize();
  const snapshot = await h.runtime.handlers['state.get']();
  assertJsonValue(snapshot);
  assert.deepEqual(snapshot.projects, [{ id: 'p1', hidden: false, count: 0, hostId: null }]);
  assert.deepEqual(snapshot.context, { branch: 'main', terminals: [{ id: 't0' }] });
});

test('malformed status events cannot poison ownership or trigger duplicate launches', async () => {
  const h = harness();
  await h.create(); await h.start();
  const before = h.runtime.getState();
  await h.events.get('agent.status.changed')({ terminalId: 't1' });
  await h.runtime.drain();
  assert.deepEqual(h.runtime.getState(), before);
  assertJsonValue(await h.runtime.handlers['state.get']());
  assert.equal(launchCalls(h).length, 1);
});

async function makeUnsentPrompt(h, phase = 'work') {
  await h.create(); await h.start();
  if (phase === 'review') { h.report(); await h.done(); }
  await h.runtime.handlers['runs.pause']({ runId: h.getRun().id });
  const job = h.currentJob();
  const agent = h.agents.find((entry) => entry.terminalId === job.terminalId);
  agent.state = 'waiting';
  delete agent.sessionId;
  await h.events.get('agent.status.changed')({ terminalId: job.terminalId, state: 'done' });
  await h.runtime.drain();
  return job;
}
const sendCalls = (h) => h.calls.filter((call) => call.name === 'terminal.sendText');

test('explicit unsent-prompt recovery focuses, persists intent, then reuses the same nonce and terminal', async () => {
  let focusObserved = false;
  const h = harness({ host: async (name, input, { store }) => {
    if (name === 'terminal.focus') {
      const run = store.get('toris-neon.runtime.v1').runs[0];
      assert.equal(run.jobs[0].promptRecovery, undefined, 'focus happens before reserving recovery');
      assert.equal(run.jobs[0].terminalId, input.terminalId);
      focusObserved = true;
      return { focused: true };
    }
    if (name === 'terminal.sendText') {
      assert.equal(focusObserved, true, 'focus must succeed before delivery');
      const run = store.get('toris-neon.runtime.v1').runs[0];
      const node = run.nodes[0];
      const job = run.jobs.find((entry) => entry.nonce === node.active.nonce);
      assert.equal(job.promptRecovery.state, 'sending');
      assert.equal(job.terminalId, input.terminalId);
      assert.equal(node.active.attempt, 1);
      assert.equal(run.status, 'paused');
      return { accepted: true };
    }
  } });
  const original = await makeUnsentPrompt(h);
  const result = await h.runtime.handlers['nodes.deliverPrompt']({
    runId: h.getRun().id, nodeId: 'build', acknowledgeUnsent: true
  });
  assert.equal(result.status, 'paused');
  assert.equal(result.nodes[0].active.nonce, original.nonce);
  assert.equal(result.nodes[0].active.attempt, original.attempt);
  assert.equal(result.nodes[0].attempts, 1);
  assert.equal(result.nodes[0].active.terminalId, original.terminalId);
  assert.equal(result.jobs[0].promptRecovery.state, 'sent');
  assert.equal(sendCalls(h).length, 1);
  assert.equal(launchCalls(h).length, 1);
  assert.equal(sendCalls(h)[0].input.enter, true);
  assert.match(sendCalls(h)[0].input.text, new RegExp(original.nonce));
  await assert.rejects(h.runtime.handlers['nodes.deliverPrompt']({
    runId: result.id, nodeId: 'build', acknowledgeUnsent: true
  }));
  assert.equal(sendCalls(h).length, 1);
});

test('failed or lost terminal focus does not reserve or send a recovery prompt', async () => {
  for (const refusal of ['false', 'error']) {
    const h = harness({ host: async (name) => {
      if (name !== 'terminal.focus') return undefined;
      if (refusal === 'error') throw Object.assign(new Error('desktop unavailable'), { code: 'unavailable' });
      return { focused: false };
    } });
    await makeUnsentPrompt(h);
    const before = h.runtime.getState();
    await assert.rejects(h.runtime.handlers['nodes.deliverPrompt']({
      runId: h.getRun().id, nodeId: 'build', acknowledgeUnsent: true
    }), /프롬프트를 전달하지 않았/);
    assert.equal(sendCalls(h).length, 0);
    assert.equal(h.getRun().jobs[0].promptRecovery, undefined);
    assert.deepEqual(h.runtime.getState(), before);
  }
});

test('recovery waits for matching workspace and terminal context before reserving or sending', async () => {
  let polls = 0;
  const waits = [];
  const h = harness({
    sleep: async (ms) => { waits.push(ms); },
    host: async (name, _input, { store }) => {
      if (name === 'workspace.readContext') {
        polls++;
        assert.equal(store.get('toris-neon.runtime.v1').runs[0].jobs[0].promptRecovery, undefined);
        if (polls === 1) return { workspaceId: 'other', terminals: [{ id: 't1' }] };
        if (polls === 2) return { workspaceId: 'w1', terminals: [{ id: 'other-terminal' }] };
        return { workspaceId: 'w1', terminals: [{ id: 't1' }] };
      }
      if (name === 'terminal.sendText') {
        assert.equal(polls, 3);
        assert.equal(store.get('toris-neon.runtime.v1').runs[0].jobs[0].promptRecovery.state, 'sending');
        return { accepted: true };
      }
    }
  });
  await makeUnsentPrompt(h);
  await h.runtime.handlers['nodes.deliverPrompt']({ runId: h.getRun().id, nodeId: 'build', acknowledgeUnsent: true });
  assert.deepEqual(waits, [100, 100]);
  assert.equal(sendCalls(h).length, 1);
});

test('focus propagation that never matches is bounded and leaves no recovery marker or send', async () => {
  let polls = 0;
  let waits = 0;
  const h = harness({
    sleep: async () => { waits++; },
    host: async (name) => {
      if (name === 'workspace.readContext') {
        polls++;
        return { workspaceId: 'other', terminals: [{ id: 't1' }] };
      }
    }
  });
  await makeUnsentPrompt(h);
  const before = h.runtime.getState();
  await assert.rejects(h.runtime.handlers['nodes.deliverPrompt']({
    runId: h.getRun().id, nodeId: 'build', acknowledgeUnsent: true
  }), /활성 작업 공간에 반영되지 않았/);
  assert.equal(polls, 26);
  assert.equal(waits, 25);
  assert.equal(sendCalls(h).length, 0);
  assert.equal(h.getRun().jobs[0].promptRecovery, undefined);
  assert.deepEqual(h.runtime.getState(), before);
});

test('prompt recovery refuses missing acknowledgement, existing receipt/session and active/mismatched agents', async () => {
  for (const condition of ['ack', 'receipt', 'job-session', 'agent-session', 'working', 'blocked', 'wrong-agent']) {
    const h = harness();
    const job = await makeUnsentPrompt(h);
    if (condition === 'receipt') h.report(job);
    if (condition === 'job-session') {
      await h.events.get('agent.status.changed')({ terminalId: job.terminalId, state: 'done', sessionId: 'existing-session' });
      await h.runtime.drain();
    }
    const agent = h.agents.find((entry) => entry.terminalId === job.terminalId);
    if (condition === 'agent-session') agent.sessionId = 'already-started';
    if (condition === 'working' || condition === 'blocked') agent.state = condition;
    if (condition === 'wrong-agent') agent.agent = 'grok';
    const before = h.runtime.getState();
    await assert.rejects(h.runtime.handlers['nodes.deliverPrompt']({
      runId: h.getRun().id, nodeId: 'build', acknowledgeUnsent: condition !== 'ack'
    }), condition);
    assert.equal(sendCalls(h).length, 0, condition);
    assert.deepEqual(h.runtime.getState(), before, condition);
  }
});

test('review prompt recovery refuses source drift without consuming the one-shot marker', async () => {
  const h = harness();
  const job = await makeUnsentPrompt(h, 'review');
  h.source('source-v2');
  const before = h.runtime.getState();
  await assert.rejects(h.runtime.handlers['nodes.deliverPrompt']({
    runId: h.getRun().id, nodeId: 'build', acknowledgeUnsent: true
  }), /소스가 변경/);
  assert.deepEqual(h.runtime.getState(), before);
  assert.equal(sendCalls(h).length, 0);
  assert.equal(h.getRun().jobs.find((entry) => entry.nonce === job.nonce).promptRecovery, undefined);
});

test('refused prompt delivery is recorded once and remains blocked without a repeated send', async () => {
  const h = harness({ host: async (name) => name === 'terminal.sendText' ? { accepted: false } : undefined });
  await makeUnsentPrompt(h);
  const input = { runId: h.getRun().id, nodeId: 'build', acknowledgeUnsent: true };
  await assert.rejects(h.runtime.handlers['nodes.deliverPrompt'](input), /수락하지/);
  assert.equal(h.getRun().status, 'paused');
  assert.equal(h.getRun().nodes[0].status, 'blocked');
  assert.equal(h.getRun().jobs[0].promptRecovery.state, 'rejected');
  await assert.rejects(h.runtime.handlers['nodes.deliverPrompt'](input), /이미 요청/);
  assert.equal(sendCalls(h).length, 1);
});

test('ambiguous prompt delivery stays uncertain across restart and cannot resend', async () => {
  const h = harness({ host: async (name) => {
    if (name === 'terminal.sendText') throw Object.assign(new Error('response timeout'), { code: 'timeout' });
  } });
  await makeUnsentPrompt(h);
  const input = { runId: h.getRun().id, nodeId: 'build', acknowledgeUnsent: true };
  await assert.rejects(h.runtime.handlers['nodes.deliverPrompt'](input), /불명확/);
  assert.equal(h.getRun().jobs[0].promptRecovery.state, 'uncertain');
  assert.equal(h.getRun().nodes[0].status, 'blocked');
  h.runtime.dispose();
  const restarted = createRuntime({ orca: h.orca, now: () => NOW });
  await restarted.initialize();
  await restarted.drain();
  await assert.rejects(restarted.handlers['nodes.deliverPrompt'](input));
  assert.equal(sendCalls(h).length, 1);
  assert.equal(launchCalls(h).length, 1);
  assert.equal(restarted.getState().runs[0].jobs[0].promptRecovery.state, 'uncertain');
  restarted.dispose();
});

test('a sending intent recovered after a worker restart becomes uncertain instead of resending', async () => {
  const h = harness();
  await makeUnsentPrompt(h);
  const saved = h.store.get('toris-neon.runtime.v1');
  const run = saved.runs[0];
  const node = run.nodes[0];
  const job = run.jobs[0];
  job.promptRecovery = { state: 'sending', at: new Date(NOW).toISOString(), terminalId: job.terminalId, acknowledgedEmpty: true };
  job.state = 'running';
  node.active = { ...node.pendingReceipt, ...job };
  node.status = 'running';
  delete node.pendingReceipt;
  h.store.set('toris-neon.runtime.v1', saved);
  h.runtime.dispose();
  const restarted = createRuntime({ orca: h.orca, now: () => NOW });
  await restarted.initialize();
  const recovered = restarted.getState().runs[0];
  assert.equal(recovered.status, 'paused');
  assert.equal(recovered.nodes[0].status, 'blocked');
  assert.equal(recovered.jobs[0].promptRecovery.state, 'uncertain');
  await assert.rejects(restarted.handlers['nodes.deliverPrompt']({
    runId: recovered.id, nodeId: 'build', acknowledgeUnsent: true
  }));
  assert.equal(sendCalls(h).length, 0);
  assert.equal(launchCalls(h).length, 1);
  restarted.dispose();
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
