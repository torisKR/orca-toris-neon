import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, buildNodePrompt, sourceFingerprint } from '../src/runtime.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRun } from '../src/engine.mjs';
import { createLaunchOverrides } from '../src/visual.mjs';
import { AUTONOMY_BRIEF, DECIDE_PROMPT } from '../src/autonomy.mjs';
import { INDEX_KEY, LEGACY_KEY, runKey, archiveKey } from '../src/store.mjs';
import { STAGE_BUDGETS } from '../src/proportion.mjs';
import { createRemoteControl } from '../src/remote.mjs';

const NOW = Date.parse('2026-11-19T05:00:00Z');
const exec = promisify(execFile);
// The stored layout (src/store.mjs): an index plus one value per run and per archived run.
function savedState(store) {
  const index = store.get(INDEX_KEY);
  const values = [...index.runs.map(runKey), ...index.archived.map(archiveKey)].map((key) => store.get(key));
  return {
    revision: Math.max(index.revision ?? 0, ...values.map((value) => value.revision ?? 0)),
    runs: index.runs.map((id) => structuredClone(store.get(runKey(id)).run)),
    archivedRuns: index.archived.map((id) => structuredClone(store.get(archiveKey(id)).run)),
  };
}
function writeSaved(store, saved) {
  for (const run of saved.runs) store.set(runKey(run.id), { version: 2, revision: saved.revision, run });
  for (const run of saved.archivedRuns) store.set(archiveKey(run.id), { version: 2, revision: saved.revision, run });
  store.set(INDEX_KEY, { version: 2, revision: saved.revision, runs: saved.runs.map((run) => run.id), archived: saved.archivedRuns.map((run) => run.id) });
}
const playAccount = { accountId: 'play-test', developerId: '1000000000000000000', accountName: 'Test Store' };
async function gitFixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'neon-runtime-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const git = args => exec('git', [
    '-c', 'core.hooksPath=' + path.join(directory, 'no-hooks'),
    '-c', 'commit.gpgsign=false', '-c', 'user.name=NEON Test',
    '-c', 'user.email=neon-test@example.invalid', '-C', directory, ...args
  ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  await git(['init', '--initial-branch=main']);
  await fs.writeFile(path.join(directory, 'app.txt'), 'alpha\n');
  await git(['add', 'app.txt']);
  await git(['commit', '-m', 'fixture']);
  return { directory, git };
}
function assertJsonValue(value, location = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') return assert.ok(Number.isFinite(value), location + ': finite number required');
  assert.equal(typeof value, 'object', location + ': Orca requires JSON, including optional own properties');
  for (const [key, item] of Object.entries(value)) assertJsonValue(item, location + '.' + key);
}
function harness(options = {}) {
  const store = options.store || new Map();
  const receipts = new Map();
  const briefs = new Map();
  const calls = [];
  const posts = [];
  const events = new Map();
  const agents = [];
  const workspaces = [];
  let sequence = 0;
  let terminalSequence = 0;
  let focusedTerminalId = null;
  let refusedFocus = 0;
  let source = 'source-v1';
  let writes = 0;
  let writeCount = 0;
  let maxWrites = 0;
  const orca = {
    storage: {
      get: async (key) => structuredClone(store.get(key) ?? null),
      set: async (key, value) => {
        assertJsonValue(value);
        writeCount++;
        writes++;
        maxWrites = Math.max(maxWrites, writes);
        await Promise.resolve();
        // Orca 1.4.268 refuses a value over 262,144 bytes of compact JSON.
        if (Buffer.byteLength(JSON.stringify(value)) > 262_144) { writes--; throw Object.assign(new Error('value exceeds 262144 bytes'), { code: 'action_failed' }); }
        if (options.failWrites?.(key)) { writes--; throw Object.assign(new Error('Orca could not complete this action'), { code: 'action_failed' }); }
        store.set(key, structuredClone(value));
        writes--;
      },
      delete: async (key) => { store.delete(key); },
      keys: async () => [...store.keys()]
    },
    panels: { post(name, value) { assertJsonValue(value); posts.push({ name, value: structuredClone(value) }); } },
    events: { on: (name, callback) => {
      events.set(name, callback);
      return { dispose: () => events.delete(name) };
    } },
    log() {},
    host: {
      has: () => true,
      call: async (name, input = {}) => {
        calls.push({ name, input: structuredClone(input) });
        if (name === 'terminal.focus' && refusedFocus > 0) { refusedFocus--; return { focused: false }; }
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
          const saved = savedState(store);
          assert.ok(saved.runs.some((run) => run.jobs.some((job) => job.state === 'launching')), 'launch intent is durable before API mutation');
          const terminalId = 't' + (++terminalSequence);
          agents.push({ terminalId, agent: input.agent, state: 'working' });
          return { terminalId };
        }
        if (name === 'agents.list') return { agents };
        if (name === 'terminal.close') {
          const agent = agents.find((item) => item.terminalId === input.terminalId);
          if (agent) Object.assign(agent, { state: 'done', closed: true });
          return { closed: true };
        }
        if (name === 'terminal.list') return { terminals: agents.filter((item) => !item.closed).map((item) => ({ id: item.terminalId })), truncated: false };
        if (name === 'terminal.sendText') return { accepted: true };
        if (name === 'terminal.focus') { focusedTerminalId = input.terminalId; return { focused: true }; }
        if (name === 'workspace.open') return { opened: true };
        if (name === 'statusBar.update') return { ok: true };
        if (name === 'notifications.show') return { delivered: true };
        throw new Error('Unexpected host API: ' + name);
      }
    }
  };
  const runtime = createRuntime({
    orca, now: options.now || (() => NOW), id: () => 'id-' + (++sequence), sleep: options.sleep || (async () => {}),
    receiptRoot: '/private/neon/runs',
    resolvePlayAccount: options.resolvePlayAccount ?? (async ({ accountId, developerId }) => {
      if (accountId !== playAccount.accountId || developerId !== playAccount.developerId) throw new Error('Play 개발자 계정을 확인해 주세요.');
      return playAccount;
    }),
    fingerprint: async () => source,
    inspectRepository: options.inspectRepository ?? (async () => ({ hasCommit: true, hasBase: true })),
    ...(options.eccAdvisor ? { eccAdvisor: options.eccAdvisor } : {}),
    receiptWrittenAt: options.receiptWrittenAt ?? (async () => null),
    ...(options.visualAdvisor ? { visualAdvisor: options.visualAdvisor } : {}),
    ...(options.launchOverrides ? { launchOverrides: options.launchOverrides } : {}),
    ...(options.readPlayApp ? { readPlayApp: options.readPlayApp } : {}),
    gitState: options.gitState ?? null, buildInfo: options.buildInfo,
    ensureDirectory: async () => {},
    writeBrief: async (filename, text) => { briefs.set(filename, text); },
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
    // Existing tests describe manual runs; autonomy is opted into explicitly.
    return runtime.handlers['runs.create']({ goal: '낚시 앱 제작', projectId: 'p1', nodes, autonomous: false, ...extras });
  };
  const start = async () => {
    await runtime.handlers['runs.start']({ runId: getRun().id });
    await runtime.drain();
  };
  return { refuseNextFocus: () => { refusedFocus++; }, runtime, orca, store, calls, posts, events, receipts, briefs, agents, workspaces, getRun, currentJob, report, done, create, start, source: (value) => { source = value; }, maxWrites: () => maxWrites, writeCount: () => writeCount };
}
const launchCalls = (h) => h.calls.filter((call) => call.name === 'agent.launch');
const sendCalls = (h) => h.calls.filter((call) => call.name === 'terminal.sendText');

test('a prompt over Orca\'s 4096-character limit is written to brief.md and the launch points to it', async () => {
  const h = harness();
  await h.runtime.initialize();
  await h.runtime.handlers['runs.create']({ goal: '샘플 게임 '.repeat(700), projectId: 'p1', nodes: [{ id: 'build', title: '앱 구현', deps: [], write: true }] });
  await h.start();
  assert.equal(launchCalls(h)[0].input.prompt, undefined);
  const prompt = sendCalls(h)[0].input.text;
  const job = h.currentJob();
  const briefPath = job.receiptDirectory + '/brief.md';
  assert.ok(prompt.length <= 4096);
  assert.ok(prompt.includes(briefPath));
  assert.ok(prompt.includes(job.receiptPath));
  assert.match(h.briefs.get(briefPath), /목표: 샘플 게임/);
});

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
  assert.equal(launchCalls(h)[1].input.prompt, undefined);
  assert.match(sendCalls(h)[1].input.text, /독립 검토자/);
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

test('wrong nonce and attempt do not pass a task; the agent is asked to correct its report', async () => {
  for (const override of [{ nonce: 'stale' }, { attempt: 999 }]) {
    const h = harness();
    await h.create(); await h.start();
    h.report(undefined, override); await h.done();
    assert.equal(h.getRun().nodes[0].status, 'running', 'not passed, not redone');
    assert.match(h.getRun().nodes[0].runtimeMessage, /식별자/);
    assert.equal(sendCalls(h).filter((call) => /보고서만 고쳐/.test(call.input.text)).length, 1);
    assert.equal(launchCalls(h).length, 1);
  }
});

test('passed receipt needs an actual artifact in addition to a reported command', async () => {
  const h = harness();
  await h.create(); await h.start();
  h.report(undefined, { evidence: [{ kind: 'command', command: 'npm test', exitCode: 0 }] });
  await h.done();
  assert.equal(h.getRun().nodes[0].status, 'running', 'not passed; the agent is asked to add the artifact');
  assert.match(h.getRun().nodes[0].runtimeMessage, /artifact/);
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

test('read-only work runs beside one writer; a second writer and reviews wait for a stable source window', async () => {
  const h = harness();
  await h.create([
    { id: 'research', title: '조사', deps: [], write: false },
    { id: 'build', title: '구현', deps: [], write: true },
    { id: 'assets', title: '에셋', deps: [], write: true }
  ], { maxConcurrency: 4 });
  await h.start();
  // A live run: assets (a writer) waited 57 minutes for read-only architecture work to finish.
  // Two assignments is also the Neon-wide limit, whatever the run allows (src/scheduler.mjs).
  assert.equal(launchCalls(h).length, 2);
  assert.equal(h.runtime.getState({ view: 'summary' }).runs[0].waiting.assets, '쓰기 작업 완료 대기', 'a second writer waits for the first');
  assert.deepEqual(h.getRun().nodes.filter((node) => node.active && node.write).map((node) => node.id), ['build']);
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

test('submission gates require a developer account, package, track, version and explicit approval', async () => {
  const h = harness();
  await h.create([{ id: 'release', title: '출시 검토', deps: [], write: true }]);
  await h.start();
  assert.equal(launchCalls(h).length, 0);
  await assert.rejects(h.runtime.handlers['runs.approve']({
    runId: h.getRun().id, nodeId: 'release',
    submission: { packageName: 'com.example.app', track: 'production', versionCode: 42 }
  }), /승인 메모/);
  await assert.rejects(h.runtime.handlers['runs.approve']({
    runId: h.getRun().id, nodeId: 'release', note: '실제 앱의 테스트와 버전을 확인한 뒤 제출 승인',
    submission: { packageName: 'com.example.app', track: 'internal', versionCode: 42 }
  }), /production/);
  await assert.rejects(h.runtime.handlers['runs.approve']({
    runId: h.getRun().id, nodeId: 'release', note: 'com.example.app production 42 제출 승인',
    submission: { packageName: 'com.example.app', track: 'production', versionCode: 42 }
  }), /Play 개발자 계정/);
  await h.runtime.handlers['runs.approve']({
    runId: h.getRun().id, nodeId: 'release', note: 'com.example.app production 42 제출 승인',
    submission: { ...playAccount, accountName: 'untrusted', packageName: 'com.example.app', track: 'production', versionCode: 42 }
  });
  await h.runtime.drain();
  assert.equal(launchCalls(h).length, 1);
  assert.match(sendCalls(h)[0].input.text, /"versionCode":"42"/);
  assert.match(sendCalls(h)[0].input.text, /"developerId":"1000000000000000000"/);
  assert.match(sendCalls(h)[0].input.text, /"accountName":"Test Store"/);
  assert.match(sendCalls(h)[0].input.text, /이 대상만 제출/);
  assert.equal(h.getRun().nodes[0].approval.sourceFingerprint, 'source-v1');
});

test('source drift after concrete submission approval prevents agent launch without an ambiguous intent', async () => {
  const h = harness();
  await h.create([{ id: 'release', title: '출시 검토', deps: [], write: true }]);
  await h.start();
  await h.runtime.handlers['runs.pause']({ runId: h.getRun().id });
  await h.runtime.handlers['runs.approve']({
    runId: h.getRun().id, nodeId: 'release', note: 'com.example.app production 42 제출 승인',
    submission: { ...playAccount, packageName: 'com.example.app', track: 'production', versionCode: 42 }
  });
  h.source('source-changed');
  await h.runtime.handlers['runs.resume']({ runId: h.getRun().id });
  await h.runtime.drain();
  assert.equal(launchCalls(h).length, 0);
  assert.equal(h.getRun().nodes[0].status, 'blocked');
  assert.equal(h.getRun().jobs[0].state, 'not-started');
  assert.equal(h.getRun().nodes[0].launchUncertain, undefined);
});

test('failed Play access verification blocks the submission before launching the worker', async () => {
  const h = harness({ resolvePlayAccount: async (_target, { verifyAccess } = {}) => {
    if (verifyAccess) throw new Error('Google denied access');
    return playAccount;
  } });
  await h.create([{ id: 'internal', title: '내부 테스트 준비', deps: [], write: true }]);
  await h.start();
  await h.runtime.handlers['runs.approve']({
    runId: h.getRun().id, nodeId: 'internal', note: 'com.example.app internal 42 제출 승인',
    submission: { ...playAccount, packageName: 'com.example.app', track: 'internal', versionCode: 42 }
  });
  await h.runtime.drain();
  assert.equal(launchCalls(h).length, 0);
  assert.equal(h.getRun().jobs[0].state, 'not-started');
  assert.match(h.getRun().nodes[0].runtimeMessage, /Google denied access/);
});

test('approval without a submission target runs preparation only', async () => {
  const h = harness();
  await h.create([{ id: 'internal', title: '내부 테스트 준비', deps: [], write: true }]);
  await h.start();
  await h.runtime.handlers['runs.approve']({ runId: h.getRun().id, nodeId: 'internal' });
  await h.runtime.drain();
  assert.equal(launchCalls(h).length, 1);
  assert.match(sendCalls(h)[0].input.text, /실제 앱 스토어 제출\/배포는 하지 마세요/);
});

test('uncertain workspace creation can attach a verified local workspace without launching', async () => {
  const h = harness({ host: async (name) => {
    if (name === 'workspace.create') throw Object.assign(new Error('response timeout'), { code: 'timeout' });
  } });
  await h.create();
  await assert.rejects(h.start(), /timeout/);
  const runId = h.getRun().id;
  // Only a workspace carrying the reserved name can be the result of the uncertain create.
  h.workspaces.push({ id: 'recovered', name: h.getRun().workspaceCreation.name, projectId: 'p1', kind: 'worktree', hostId: 'local', path: '/repo/recovered' });
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

test('archive keeps dates, receipts, report summaries and the latest events; full reports stay in the result folders', async () => {
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
  const kept = (nodes) => nodes.map((node) => [node.id, node.status, node.completedAt, node.receipt?.path, node.report?.summary, node.review?.summary]);
  assert.deepEqual(kept(archived.nodes), kept(completed.nodes));
  assert.deepEqual(archived.events.slice(0, -1), completed.events.slice(-(archived.events.length - 1)));
  assert.match(archived.events.at(-1).summary, /보관했습니다/);
  assert.equal(archived.archivedAt, new Date(NOW).toISOString());
  assert.equal(savedState(h.store).archivedRuns[0].id, completed.id);
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
  assert.equal(savedState(h.store).runs[0].jobs[0].terminalId, 't1');
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

// The automatic delivery stops at a refused focus, so nothing was typed into the terminal.
async function makeUnsentPrompt(h, phase = 'work') {
  if (phase === 'work') h.refuseNextFocus();
  await h.create(); await h.start();
  if (phase === 'review') { h.refuseNextFocus(); h.report(); await h.done(); }
  await h.runtime.handlers['runs.pause']({ runId: h.getRun().id });
  const job = h.currentJob();
  const agent = h.agents.find((entry) => entry.terminalId === job.terminalId);
  agent.state = 'waiting';
  delete agent.sessionId;
  await h.events.get('agent.status.changed')({ terminalId: job.terminalId, state: 'done' });
  await h.runtime.drain();
  return job;
}

test('explicit unsent-prompt recovery focuses, persists intent, then reuses the same nonce and terminal', async () => {
  let focusObserved = false;
  const h = harness({ host: async (name, input, { store }) => {
    if (name === 'terminal.focus') {
      const run = savedState(store).runs[0];
      assert.equal(run.jobs[0].promptRecovery, undefined, 'focus happens before reserving recovery');
      assert.equal(run.jobs[0].terminalId, input.terminalId);
      focusObserved = true;
      return { focused: true };
    }
    if (name === 'terminal.sendText') {
      assert.equal(focusObserved, true, 'focus must succeed before delivery');
      const run = savedState(store).runs[0];
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
        assert.equal(savedState(store).runs[0].jobs[0].promptRecovery, undefined);
        if (polls === 1) return { workspaceId: 'other', terminals: [{ id: 't1' }] };
        if (polls === 2) return { workspaceId: 'w1', terminals: [{ id: 'other-terminal' }] };
        return { workspaceId: 'w1', terminals: [{ id: 't1' }] };
      }
      if (name === 'terminal.sendText') {
        assert.equal(polls, 3);
        assert.equal(savedState(store).runs[0].jobs[0].promptRecovery.state, 'sending');
        return { accepted: true };
      }
    }
  });
  await makeUnsentPrompt(h);
  waits.length = 0; // makeUnsentPrompt also waits out the delivery grace period
  await h.runtime.handlers['nodes.deliverPrompt']({ runId: h.getRun().id, nodeId: 'build', acknowledgeUnsent: true });
  assert.deepEqual(waits.filter((ms) => ms === 100), [100, 100]);
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
  waits = 0; // makeUnsentPrompt also waits out the delivery grace period
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
  // A session id is no evidence of a prompt: Claude reports one when it is idle and ready,
  // before the plugin types anything. Only a turn (working/blocked) or a receipt is.
  for (const condition of ['ack', 'receipt', 'working', 'blocked', 'wrong-agent']) {
    const h = harness();
    const job = await makeUnsentPrompt(h);
    if (condition === 'receipt') h.report(job);
    const agent = h.agents.find((entry) => entry.terminalId === job.terminalId);
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
  const sent = sendCalls(h).length; // the work stage was typed automatically before the review
  await assert.rejects(h.runtime.handlers['nodes.deliverPrompt']({
    runId: h.getRun().id, nodeId: 'build', acknowledgeUnsent: true
  }), /소스가 변경/);
  assert.deepEqual(h.runtime.getState(), before);
  assert.equal(sendCalls(h).length, sent);
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
  const saved = savedState(h.store);
  const run = saved.runs[0];
  const node = run.nodes[0];
  const job = run.jobs[0];
  job.promptRecovery = { state: 'sending', at: new Date(NOW).toISOString(), terminalId: job.terminalId, acknowledgedEmpty: true };
  job.state = 'running';
  node.active = { ...node.pendingReceipt, ...job };
  node.status = 'running';
  delete node.pendingReceipt;
  writeSaved(h.store, saved);
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

test('audit: unrelated and duplicate agent events do not rewrite persisted runs', async () => {
  const h = harness();
  await h.create(); await h.start();
  const beforeUnrelated = h.writeCount();
  await h.events.get('agent.status.changed')({ terminalId: 'foreign', state: 'working', receivedAt: NOW + 10 });
  await h.runtime.drain();
  assert.equal(h.writeCount(), beforeUnrelated);
  const event = { terminalId: 't1', state: 'working', receivedAt: NOW + 20 };
  await h.events.get('agent.status.changed')(event);
  await h.runtime.drain();
  const beforeDuplicate = h.writeCount();
  await h.events.get('agent.status.changed')(event);
  await h.runtime.drain();
  assert.equal(h.writeCount(), beforeDuplicate);
});

test('audit: an older done event cannot interrupt a newer working state', async () => {
  const h = harness();
  await h.create(); await h.start();
  await h.events.get('agent.status.changed')({ terminalId: 't1', state: 'working', receivedAt: NOW + 200 });
  await h.events.get('agent.status.changed')({ terminalId: 't1', state: 'done', receivedAt: NOW + 100 });
  await h.runtime.drain();
  assert.equal(h.getRun().nodes[0].status, 'running');
  assert.equal(h.getRun().jobs[0].agentState, 'working');
});

test('audit: a known failed outcome cannot be erased by an outcome-less completion', async () => {
  const h = harness();
  await h.create(); await h.start();
  // Paused, so the failed turn blocks at once instead of being continued (continuations are tested below).
  await h.runtime.handlers['runs.pause']({ runId: h.getRun().id });
  h.agents[0].state = 'done';
  const job = h.currentJob();
  await h.events.get('agent.status.changed')({ terminalId: 't1', state: 'done', receivedAt: NOW + 10, mainAgent: { outcome: 'failure' } });
  h.report(job);
  await h.events.get('agent.status.changed')({ terminalId: 't1', state: 'done', receivedAt: NOW + 20 });
  await h.runtime.drain();
  assert.equal(h.getRun().nodes[0].status, 'blocked');
  assert.equal(h.getRun().jobs[0].agentOutcome, 'failure');
  assert.equal(launchCalls(h).length, 1);
});

test('audit: retry refuses an awaiting-report terminal that became active again', async () => {
  const h = harness();
  await h.create(); await h.start();
  await h.runtime.handlers['runs.pause']({ runId: h.getRun().id });
  await h.done();
  h.agents[0].state = 'working';
  const before = h.runtime.getState();
  await assert.rejects(h.runtime.handlers['nodes.retry']({ runId: h.getRun().id, nodeId: 'build' }), /실행 중/);
  assert.deepEqual(h.runtime.getState(), before);
});

test('audit: retry requires a confirmed terminal close before superseding the old attempt', async () => {
  const h = harness({ host: async (name) => name === 'terminal.close' ? { closed: false } : undefined });
  await h.create(); await h.start();
  await h.runtime.handlers['runs.pause']({ runId: h.getRun().id });
  await h.done();
  h.agents[0].state = 'working';
  await h.runtime.handlers['runs.refresh']({ runId: h.getRun().id });
  const before = h.runtime.getState();
  await assert.rejects(h.runtime.handlers['nodes.retry']({ runId: h.getRun().id, nodeId: 'build', stopPrevious: true }), /종료/);
  assert.deepEqual(h.runtime.getState(), before);
  assert.equal(launchCalls(h).length, 1);
});

test('audit: cancelled runs cannot accept late receipts through manual refresh', async () => {
  const h = harness({ host: async (name) => {
    if (name === 'terminal.close') throw new Error('host could not stop terminal');
  } });
  await h.create(); await h.start();
  const job = h.currentJob();
  await h.done();
  await h.runtime.handlers['runs.cancel']({ runId: h.getRun().id });
  h.report(job);
  const before = h.runtime.getState();
  await h.runtime.handlers['runs.refresh']({ runId: h.getRun().id });
  await h.runtime.drain();
  assert.deepEqual(h.runtime.getState(), before);
});

test('audit: cancellation records an unconfirmed close as a stop failure', async () => {
  const h = harness({ host: async (name) => name === 'terminal.close' ? { closed: false } : undefined });
  await h.create(); await h.start();
  await h.runtime.handlers['runs.cancel']({ runId: h.getRun().id });
  assert.equal(h.getRun().stopFailures.length, 1);
  await assert.rejects(h.runtime.handlers['runs.archive']({ runId: h.getRun().id }));
});

test('stale recovery confirmations cannot apply to a different pending assignment', async () => {
  for (const method of ['nodes.retry', 'nodes.deliverPrompt']) {
    const h = harness();
    await makeUnsentPrompt(h);
    const runId = h.getRun().id;
    const nonce = h.currentJob().nonce;
    const before = h.runtime.getState();
    const calls = h.calls.length;
    const writes = h.writeCount();
    await assert.rejects(h.runtime.handlers[method]({
      runId, nodeId: 'build', expectedNonce: nonce + '-stale',
      acknowledgeUnsent: true, acknowledgeUncertain: true, stopPrevious: true
    }), error => error.code === 'stale_assignment');
    assert.deepEqual(h.runtime.getState(), before);
    assert.equal(h.calls.length, calls, 'stale confirmation must not inspect or mutate a host terminal');
    assert.equal(h.writeCount(), writes);
  }
});

test('matching expectedNonce permits the existing once-only recovery and retry paths', async () => {
  const recover = harness();
  await makeUnsentPrompt(recover);
  const recoveryJob = recover.currentJob();
  await recover.runtime.handlers['nodes.deliverPrompt']({
    runId: recover.getRun().id, nodeId: 'build',
    expectedNonce: recoveryJob.nonce, acknowledgeUnsent: true
  });
  assert.equal(recover.currentJob().nonce, recoveryJob.nonce);
  assert.equal(recover.getRun().jobs[0].promptRecovery.state, 'sent');

  const retry = harness();
  await makeUnsentPrompt(retry);
  const prior = retry.currentJob();
  await retry.runtime.handlers['nodes.retry']({
    runId: retry.getRun().id, nodeId: 'build', expectedNonce: prior.nonce, stopPrevious: true
  });
  assert.equal(retry.getRun().jobs[0].state, 'superseded');
  assert.equal(retry.getRun().nodes[0].status, 'pending');
});

test('source fingerprint rejects hidden tracked changes before independent review can pass', async t => {
  const { directory, git } = await gitFixture(t);
  const original = await sourceFingerprint(directory);
  await fs.writeFile(path.join(directory, 'app.txt'), 'bravo\n');
  assert.notEqual(await sourceFingerprint(directory), original);
  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    await git(['update-index', '--' + flag, 'app.txt']);
    await assert.rejects(sourceFingerprint(directory), error => error.code === 'not_permitted' && /assume-unchanged/.test(error.message));
    await git(['update-index', '--no-' + flag, 'app.txt']);
  }
  await fs.writeFile(path.join(directory, 'app.txt'), 'alpha\n');
  assert.equal(await sourceFingerprint(directory), original);
});

test('source fingerprint rejects a tracked regular file replaced by a symlink', { skip: process.platform === 'win32' }, async t => {
  const { directory, git } = await gitFixture(t);
  await sourceFingerprint(directory);
  await fs.writeFile(path.join(directory, 'target.txt'), 'external value\n');
  await fs.unlink(path.join(directory, 'app.txt'));
  await fs.symlink(path.join(directory, 'target.txt'), path.join(directory, 'app.txt'));
  await assert.rejects(sourceFingerprint(directory), error => error.code === 'not_permitted' && /심볼릭/.test(error.message));
  await git(['add', 'app.txt']);
  await assert.rejects(sourceFingerprint(directory), error => error.code === 'not_permitted' && /심볼릭/.test(error.message));
});

test('summary transport preserves current ownership; a migrated old value keeps live evidence and trims archives', async () => {
  const record = createRun({ id: 'large-run', goal: '실제 검증 이력', projectId: 'p1', now: NOW,
    nodes: [{ id: 'inspect', title: '검증', deps: [], write: false }] });
  record.status = 'completed';
  record.nodes[0].status = 'passed';
  const evidence = Array.from({ length: 32 }, (_, i) => ({ kind: 'note', text: String(i) + '검증 자료'.repeat(250) }));
  record.nodes[0].report = { outcome: 'passed', summary: '구현 완료', evidence };
  record.nodes[0].review = { outcome: 'passed', summary: '독립 검증 완료', evidence };
  record.nodes[0].history = [structuredClone(record.nodes[0].report), structuredClone(record.nodes[0].review)];
  record.nodes[0].receipt = { path: '/private/result.json', at: new Date(NOW).toISOString(), phase: 'review',
    artifacts: [{ path: '/private/proof.md', sha256: 'hash', size: 120 }] };
  record.events = Array.from({ length: 80 }, (_, i) => ({
    id: 'event-' + i, at: new Date(NOW).toISOString(), type: 'runtime',
    summary: '검증 이벤트 ' + i, workspaceId: 'w1'
  }));
  record.jobs = [{ nonce: 'old', state: 'complete', terminalId: 'old-terminal' }];
  const archived = Array.from({ length: 12 }, (_, i) => ({
    ...structuredClone(record), id: 'archive-' + i, archivedAt: new Date(NOW).toISOString()
  }));
  const active = structuredClone(record);
  active.status = 'blocked';
  active.nodes[0].status = 'blocked';
  active.nodes[0].pendingReceipt = { nonce: 'current', terminalId: 'current-terminal' };
  Object.assign(active.nodes[0].report, { changes: ['x'], criteria: [{ criterion: 'c', met: true }], beforeAfter: [{ label: 'l', before: '1', after: '2' }], notVerified: ['n'] });
  active.improvement = { kind: 'bugfix', parent: { runId: 'p', summary: '이전 결과 '.repeat(300) } };
  active.jobs.push({ nonce: 'current', state: 'awaiting-report', terminalId: 'current-terminal' });
  const store = new Map([[LEGACY_KEY, { version: 1, runs: [active], archivedRuns: archived }]]);
  const h = harness({ store });
  await h.runtime.initialize();
  const full = await h.runtime.handlers['state.get']();
  const summary = await h.runtime.handlers['state.get']({ view: 'summary' });
  assert.deepEqual(full.runs[0].nodes[0].report.evidence, evidence, 'a live run keeps its evidence in memory');
  assert.equal(full.archivedRuns[0].nodes[0].report.evidence, undefined, 'archived evidence stays in the receipt folders');
  assert.equal(full.archivedRuns[0].nodes[0].report.evidenceOmitted, 32);
  assert.equal((await h.runtime.handlers['runs.get']({ runId: archived[0].id })).nodes[0].report.summary, '구현 완료');
  assert.equal(summary.runs[0].nodes[0].pendingReceipt.terminalId, 'current-terminal');
  assert.deepEqual(summary.runs[0].jobs.map(job => job.nonce), ['current']);
  assert.equal(summary.runs[0].nodes[0].report.evidence, undefined);
  assert.equal(summary.runs[0].nodes[0].report.evidenceCount, 32);
  for (const field of ['changes', 'criteria', 'beforeAfter', 'notVerified']) assert.equal(summary.runs[0].nodes[0].report[field], undefined, field + ' is read with the run, not pushed');
  assert.deepEqual(summary.runs[0].improvement.parent, { runId: 'p' });
  assert.deepEqual(full.runs[0].nodes[0].report.changes, ['x']);
  assert.equal(summary.runs[0].nodes[0].history, undefined);
  assert.equal(summary.runs[0].nodes[0].receipt.artifactCount, 1);
  assert.equal(summary.archivedRuns[0].nodes, undefined);
  assert.equal(summary.archivedRuns[0].events, undefined);
  assert.equal(summary.archivedRuns[0].nodeCount, 1);
  assert.equal(summary.archivedRuns[0].passedCount, 1);
  assert.equal(summary.archivedRuns[0].createdAt, archived[0].createdAt);
  assert.equal(summary.archivedRuns[0].archivedAt, archived[0].archivedAt);
  const fullBytes = Buffer.byteLength(JSON.stringify(full));
  const summaryBytes = Buffer.byteLength(JSON.stringify(summary));
  assert.ok(summaryBytes < fullBytes / 20, 'summary should omit bulk history and evidence: ' + summaryBytes + '/' + fullBytes);
  const timeline = h.runtime.getState({ view: 'timeline' });
  assert.deepEqual(timeline.archivedRuns[0].events, archived[0].events.slice(-10), 'archives keep their latest events');
  assert.equal(full.archivedRuns[0].eventsOmitted, 70);
  assert.equal(timeline.runs[0].events[0].workspaceId, 'w1');
  assert.equal(timeline.runs[0].nodes, undefined);
  assert.equal(timeline.runs[0].projectId, 'p1');
  assert.deepEqual(h.posts.at(-1).value, h.runtime.getState({ view: 'summary' }));
  assert.equal(store.has(LEGACY_KEY), false, 'the old single value is gone once the new layout is verified');
  assert.deepEqual(savedState(store).archivedRuns.map((run) => run.id), archived.map((run) => run.id), 'every archived run is kept');
  const stored = savedState(store).runs[0].nodes[0].report;
  assert.equal(stored.evidence.length + stored.evidenceOmitted, 32, 'a live run over its budget is stored with fewer, shorter evidence items and their count');
  assert.equal(stored.evidence[0].text.slice(0, 20), evidence[0].text.slice(0, 20));
  await assert.rejects(h.runtime.handlers['runs.get']({ runId: 'missing' }), /찾을 수/);
});

test('state revisions are durable and monotonic; status bar skips unchanged counts', async () => {
  const h = harness();
  await h.create();
  const before = h.runtime.getState().revision;
  assert.ok(before >= 2);
  const statusCalls = h.calls.filter(call => call.name === 'statusBar.update').length;
  await h.runtime.handlers['runs.updateAssignments']({ runId: h.getRun().id, assignments: { build: { agent: 'claude' } } });
  assert.equal(h.runtime.getState().revision, before + 1);
  assert.equal(h.calls.filter(call => call.name === 'statusBar.update').length, statusCalls);
  const revisions = h.posts.map(post => post.value.revision);
  assert.ok(revisions.every((revision, i) => i === 0 || revision > revisions[i - 1]));
  assert.equal(savedState(h.store).revision, revisions.at(-1));
  h.runtime.dispose();
  const restarted = harness({ store: h.store });
  await restarted.runtime.initialize();
  assert.equal(restarted.runtime.getState().revision, revisions.at(-1) + 1);
});

test('catalog reads coalesce in flight, expire quickly and honor explicit refresh', async () => {
  let clock = NOW;
  let resolveProject;
  const projectGate = new Promise(resolve => { resolveProject = resolve; });
  const h = harness({ now: () => clock, host: async (name) => {
    if (name === 'project.list') {
      await projectGate;
      return { projects: [{ id: 'p1', name: 'App' }] };
    }
  } });
  await h.runtime.initialize();
  const one = h.runtime.handlers['state.get']({ view: 'summary' });
  const two = h.runtime.handlers['state.get']({ view: 'summary' });
  await Promise.resolve(); await Promise.resolve();
  const count = name => h.calls.filter(call => call.name === name).length;
  for (const name of ['project.list', 'workspace.list', 'workspace.readContext', 'agents.list']) assert.equal(count(name), 1);
  resolveProject();
  await Promise.all([one, two]);
  await h.runtime.handlers['state.get']();
  for (const name of ['project.list', 'workspace.list', 'workspace.readContext', 'agents.list']) assert.equal(count(name), 1);
  clock += 300;
  await h.runtime.handlers['state.get']({ view: 'summary' });
  assert.equal(count('project.list'), 1);
  assert.equal(count('workspace.list'), 1);
  assert.equal(count('workspace.readContext'), 2);
  assert.equal(count('agents.list'), 2);
  await h.runtime.handlers['state.get']({ forceHost: true });
  assert.equal(count('project.list'), 2);
  assert.equal(count('workspace.list'), 2);
  assert.equal(count('workspace.readContext'), 3);
  assert.equal(count('agents.list'), 3);
  await h.events.get('workspace.changed')({});
  await h.runtime.handlers['state.get']();
  assert.equal(count('project.list'), 3);
  assert.equal(count('workspace.list'), 3);
});

test('catalog errors are retried and do not poison cached successful sections', async () => {
  let failure = true;
  const h = harness({ host: async (name) => {
    if (name === 'project.list' && failure) throw new Error('temporarily unavailable');
  } });
  await h.runtime.initialize();
  const first = await h.runtime.handlers['state.get']();
  assert.deepEqual(first.projects, []);
  assert.match(first.warnings.join(' '), /temporarily unavailable/);
  failure = false;
  const second = await h.runtime.handlers['state.get']();
  assert.equal(second.projects[0].id, 'p1');
  assert.deepEqual(second.warnings, []);
  assert.equal(h.calls.filter(call => call.name === 'project.list').length, 2);
  assert.equal(h.calls.filter(call => call.name === 'workspace.list').length, 1);
});

test('read-only state and detail remain available while a host launch is pending', async () => {
  let entered;
  let release;
  const launching = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness({ host: async (name) => {
    if (name === 'agent.launch') { entered(); await pending; }
  } });
  await h.create();
  const start = h.start();
  await launching;
  const result = await h.runtime.handlers['state.get']({ view: 'summary' });
  assert.equal(result.runs[0].jobs[0].state, 'launching');
  const detail = await h.runtime.handlers['runs.get']({ runId: h.getRun().id });
  assert.equal(detail.jobs[0].state, 'launching');
  assert.equal(savedState(h.store).runs[0].jobs[0].nonce, detail.jobs[0].nonce);
  release();
  await start;
  assert.equal(launchCalls(h).length, 1);
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

const closeCalls = (h) => h.calls.filter((call) => call.name === 'terminal.close');

test('a definite workspace.create failure on a repository without commits explains the cause and stays startable', async () => {
  const h = harness({ inspectRepository: async () => ({ hasCommit: false, hasBase: true }) });
  await h.create();
  await assert.rejects(h.start(), /커밋이 없어/);
  const run = h.getRun();
  assert.equal(h.calls.filter((call) => call.name === 'workspace.create').length, 0);
  assert.match(run.runtimeMessage, /첫 커밋/);
  assert.notEqual(run.workspaceCreation?.state, 'uncertain');
  assert.equal(run.status, 'ready');
});

test('a generic host refusal with nothing created is a definite failure retried by the same start', async () => {
  let fail = true;
  const h = harness({ host: async (name) => {
    if (name === 'workspace.create' && fail) throw Object.assign(new Error('Orca could not complete this action'), { code: 'action_failed' });
  } });
  await h.create();
  await assert.rejects(h.start(), /작업 공간을 만들지 못했습니다/);
  assert.equal(h.getRun().workspaceCreation.state, 'failed');
  assert.match(h.getRun().runtimeMessage, /Orca could not complete this action/);
  fail = false;
  await h.start();
  assert.equal(h.getRun().workspaceId, 'w1');
  assert.equal(launchCalls(h).length, 1);
});

test('an uncertain creation with no workspace of the reserved name is created again', async () => {
  let fail = true;
  const h = harness({ host: async (name) => {
    if (name === 'workspace.create' && fail) throw Object.assign(new Error('response timeout'), { code: 'timeout' });
  } });
  await h.create();
  await assert.rejects(h.start(), /timeout/);
  assert.equal(h.getRun().workspaceCreation.state, 'uncertain');
  fail = false;
  await h.start();
  assert.equal(h.calls.filter((call) => call.name === 'workspace.create').length, 2);
  assert.equal(h.getRun().workspaceId, 'w1');
});

test('an uncertain creation with any workspace of the reserved name conflicts instead of creating twice', async () => {
  for (const count of [1, 2]) {
    const h = harness({ host: async (name) => {
      if (name === 'workspace.create') throw Object.assign(new Error('response timeout'), { code: 'timeout' });
    } });
    await h.create();
    await assert.rejects(h.start(), /timeout/);
    const reserved = h.getRun().workspaceCreation.name;
    for (let index = 0; index < count; index++) {
      h.workspaces.push({ id: 'dup' + index, name: reserved, projectId: 'p1', kind: 'worktree', hostId: count === 1 ? 'ssh:remote' : 'local', path: '/repo/dup' + index });
    }
    await assert.rejects(h.start(), /불명확/);
    assert.equal(h.calls.filter((call) => call.name === 'workspace.create').length, 1, String(count));
  }
});

test('attaching refuses the project checkout and workspaces without the reserved name', async () => {
  const h = harness({ host: async (name) => {
    if (name === 'workspace.create') throw Object.assign(new Error('response timeout'), { code: 'timeout' });
  } });
  await h.create();
  await assert.rejects(h.start(), /timeout/);
  const reserved = h.getRun().workspaceCreation.name;
  h.workspaces.push(
    { id: 'primary', name: reserved, projectId: 'p1', kind: 'worktree', hostId: 'local', path: '/repo' },
    { id: 'main', name: 'main', projectId: 'p1', kind: 'worktree', hostId: 'local', path: '/repo/main' }
  );
  for (const workspaceId of ['primary', 'main']) {
    const before = h.runtime.getState();
    await assert.rejects(h.runtime.handlers['runs.attachWorkspace']({ runId: h.getRun().id, workspaceId }), /예약/);
    assert.deepEqual(h.runtime.getState(), before);
  }
});

const godotAdvice = {
  version: '2.2.3', stack: { stacks: ['godot'], label: 'Godot/GDScript', source: 'files' },
  situation: { stage: 'build', phase: 'work', attempt: 2, summary: '구현 작업 2회차 · 검토 실패 후 수정' },
  agents: [{ name: 'ecc:gdscript-reviewer', why: 'Godot 코드 검토', description: 'Reviews GDScript.' }],
  skills: [{ name: 'ecc:godot-patterns', why: 'Godot 구현 패턴', description: 'Idiomatic Godot 4.' }]
};
test('a claude stage prompt lists the situational ECC agents and skills as data with how to use them; codex gets none', () => {
  const run = { id: 'r', goal: '앱 제작', workspacePath: '/repo', nodes: [] };
  const node = { id: 'build', title: '구현', deps: [], write: true, report: null };
  const job = (agent, ecc = godotAdvice) => ({ runId: 'r', nodeId: 'build', nonce: 'n', phase: 'work', attempt: 2, agent, receiptDirectory: '/private/r', receiptPath: '/private/r/result.json', ecc });
  const claude = buildNodePrompt(run, node, job('claude'));
  for (const text of ['ecc:gdscript-reviewer', 'ecc:godot-patterns', 'Godot/GDScript', '검토 실패 후 수정']) assert.ok(claude.includes(text), text);
  assert.match(claude, /참고 자료/);
  assert.match(claude, /다른 설치된 ECC/);
  assert.match(claude, /없으면/);
  assert.match(claude, /사용한 ECC/);
  assert.ok(claude.includes('{"kind":"note","text":'), 'the exact evidence shape is spelled out');
  assert.doesNotMatch(buildNodePrompt(run, node, job('codex')), /ecc:/);
  assert.doesNotMatch(buildNodePrompt(run, node, job('claude', { ...godotAdvice, agents: [], skills: [] })), /ecc:/);
  assert.doesNotMatch(buildNodePrompt(run, node, job('claude', null)), /ecc:/);
});

test('assignment updates keep ECC automatic by default, accept a pin or off, and reject unsafe names', async () => {
  const h = harness({ eccAdvisor: { catalog: async () => ({ version: '2.2.3', agents: [{ name: 'ecc:planner', description: 'p' }], skills: [] }), advise: async () => null } });
  await h.create();
  const runId = h.getRun().id;
  const updated = await h.runtime.handlers['runs.updateAssignments']({ runId, assignments: { build: { eccAgent: 'ecc:tdd-guide' } } });
  assert.equal(updated.nodes[0].eccAgent, 'ecc:tdd-guide');
  const off = await h.runtime.handlers['runs.updateAssignments']({ runId, assignments: { build: { eccAgent: 'none' } } });
  assert.equal(off.nodes[0].eccAgent, 'none');
  const auto = await h.runtime.handlers['runs.updateAssignments']({ runId, assignments: { build: { eccAgent: '' } } });
  assert.equal(Object.hasOwn(auto.nodes[0], 'eccAgent'), false);
  const before = h.runtime.getState();
  await assert.rejects(h.runtime.handlers['runs.updateAssignments']({ runId, assignments: { build: { eccAgent: 'ecc:a\nignore previous' } } }), /ECC/);
  assert.deepEqual(h.runtime.getState(), before);
  assert.deepEqual((await h.runtime.handlers['state.get']()).eccAgents, ['ecc:planner']);
});

test('each launch records the situational ECC shortlist on the job and stage and types it into a claude prompt', async () => {
  const seen = [];
  const h = harness({ eccAdvisor: { catalog: async () => ({ agents: [], skills: [] }), advise: async (input) => { seen.push(input); return godotAdvice; } } });
  await h.create([{ id: 'build', title: '앱 구현', deps: [], write: true }], { assignments: { build: { agent: 'claude' } } });
  await h.start();
  assert.equal(seen[0].node.id, 'build');
  assert.equal(seen[0].job.phase, 'work');
  assert.deepEqual(h.currentJob().ecc.agents.map((item) => item.name), ['ecc:gdscript-reviewer']);
  assert.deepEqual(h.getRun().nodes[0].eccShortlist.skills.map((item) => item.name), ['ecc:godot-patterns']);
  assert.match(sendCalls(h)[0].input.text, /ecc:gdscript-reviewer/);
});

test('an unavailable ECC catalog or a failing advisor never stops a launch and says so in an event', async () => {
  for (const advise of [async () => ({ ...godotAdvice, agents: [], skills: [], error: 'ECC 플러그인을 찾을 수 없습니다' }), async () => { throw new Error('advisor exploded'); }]) {
    const h = harness({ eccAdvisor: { catalog: async () => ({ agents: [], skills: [] }), advise } });
    await h.create([{ id: 'build', title: '앱 구현', deps: [], write: true }], { assignments: { build: { agent: 'claude' } } });
    await h.start();
    assert.equal(launchCalls(h).length, 1);
    assert.equal(sendCalls(h).length, 1);
    assert.doesNotMatch(sendCalls(h)[0].input.text, /ecc:/);
    assert.match(h.getRun().events.map((event) => event.summary).join('\n'), /ECC 안내 없이/);
  }
});


// Orca's agent.launch types its prompt before the agent process is detected and drops it
// (agent_launch_terminal_not_running_agent). The plugin launches without a prompt and types it itself.
test('a stage launches without a prompt, then types it once into its opened and focused terminal', async () => {
  const h = harness({ host: async (name, input, { store }) => {
    if (name !== 'terminal.sendText') return undefined;
    const job = savedState(store).runs[0].jobs.find((entry) => entry.terminalId === input.terminalId);
    assert.equal(job.promptRecovery.state, 'sending', 'the one-shot intent is durable before typing');
    return { accepted: true };
  } });
  await h.create(); await h.start();
  const launch = launchCalls(h);
  assert.equal(launch.length, 1);
  assert.equal(Object.hasOwn(launch[0].input, 'prompt'), false);
  const order = h.calls.map((call) => call.name);
  assert.ok(order.indexOf('agent.launch') < order.indexOf('workspace.open'));
  assert.ok(order.indexOf('workspace.open') < order.indexOf('terminal.focus'));
  assert.ok(order.indexOf('terminal.focus') < order.indexOf('terminal.sendText'));
  assert.equal(h.calls.filter((call) => call.name === 'terminal.focus').length, 1, 'one focus per job');
  const job = h.currentJob();
  assert.equal(sendCalls(h).length, 1);
  assert.deepEqual({ terminalId: sendCalls(h)[0].input.terminalId, enter: sendCalls(h)[0].input.enter }, { terminalId: job.terminalId, enter: true });
  assert.match(sendCalls(h)[0].input.text, new RegExp(job.nonce));
  assert.equal(job.promptRecovery.state, 'sent');
  assert.match(h.getRun().events.map((event) => event.summary).join('\n'), /에이전트 터미널을 열고 작업 지시를 전달했습니다/);
  h.report(); await h.done();
  assert.equal(h.currentJob().phase, 'review');
  assert.equal(sendCalls(h).length, 2, 'the review is delivered the same way');
  assert.equal(launchCalls(h)[1].input.prompt, undefined);
});

test('nothing is typed until the agent reports in; its idle done is the ready signal, not a finished job', async () => {
  const seen = [];
  let fired = false;
  const h = harness({
    sleep: async () => {
      seen.push(sendCalls(h).length);
      if (!fired && seen.length === 2) {
        fired = true;
        await h.events.get('agent.status.changed')({ terminalId: 't1', state: 'done', sessionId: 'idle' });
      }
    },
    // Not listed until it reports idle; listed as working once the typed prompt starts a turn.
    host: async (name) => name === 'agents.list' && !fired ? { agents: [] } : undefined
  });
  await h.create(); await h.start();
  assert.deepEqual(seen.slice(0, 2), [0, 0]);
  assert.equal(sendCalls(h).length, 1);
  const node = h.getRun().nodes[0];
  assert.equal(node.status, 'running');
  assert.doesNotMatch(node.runtimeMessage ?? '', /보고서가 없습니다/);
});

test('an agent that never becomes ready is closed and relaunched, then stops with a safe-to-retry message', async () => {
  const h = harness({ host: async (name) => name === 'agents.list' ? { agents: [] } : undefined });
  await h.create(); await h.start();
  assert.equal(sendCalls(h).length, 0);
  assert.equal(launchCalls(h).length, 3);
  assert.equal(closeCalls(h).length, 3);
  const node = h.getRun().nodes[0];
  assert.equal(node.status, 'blocked');
  assert.equal(node.attempts, 0, 'an agent that never received a prompt does not use an attempt');
  assert.match(node.failureReason, /준비되지 않아/);
  assert.match(node.failureReason, /다시 시도해도 안전/);
  assert.equal(node.launchUncertain, undefined);
  await h.runtime.handlers['nodes.retry']({ runId: h.getRun().id, nodeId: 'build' });
  await h.runtime.drain();
  assert.equal(launchCalls(h).length, 6);
});

test('an unready agent whose terminal cannot be closed is never relaunched', async () => {
  const h = harness({ host: async (name) => name === 'agents.list' ? { agents: [] } : name === 'terminal.close' ? { closed: false } : undefined });
  await h.create(); await h.start();
  assert.equal(launchCalls(h).length, 1);
  assert.equal(h.getRun().nodes[0].status, 'blocked');
  assert.match(h.getRun().nodes[0].runtimeMessage, /닫지 못해/);
});

test('a prompt Orca refuses to type is blocked once and never resent', async () => {
  const h = harness({ host: async (name) => name === 'terminal.sendText' ? { accepted: false } : undefined });
  await h.create(); await h.start();
  await h.runtime.handlers['runs.refresh']({ runId: h.getRun().id });
  await h.runtime.handlers['runs.resume']({ runId: h.getRun().id });
  await h.runtime.drain();
  assert.equal(sendCalls(h).length, 1);
  assert.equal(launchCalls(h).length, 1);
  assert.equal(h.getRun().jobs[0].promptRecovery.state, 'rejected');
  assert.equal(h.getRun().nodes[0].status, 'blocked');
});

test('an ambiguous typing request is uncertain and never resent', async () => {
  const h = harness({ host: async (name) => {
    if (name === 'terminal.sendText') throw Object.assign(new Error('response timeout'), { code: 'timeout' });
  } });
  await h.create(); await h.start();
  await h.runtime.handlers['runs.resume']({ runId: h.getRun().id });
  await h.runtime.drain();
  assert.equal(sendCalls(h).length, 1);
  assert.equal(launchCalls(h).length, 1);
  assert.equal(h.getRun().jobs[0].promptRecovery.state, 'uncertain');
  assert.ok(h.getRun().nodes[0].launchUncertain);
});

test('a typed prompt that never starts a turn is blocked as uncertain, not resent or relaunched', async () => {
  const h = harness({ host: async (name, _input, { agents }) => name === 'agents.list' ? { agents: agents.map((agent) => ({ ...agent, state: 'done' })) } : undefined });
  await h.create(); await h.start();
  assert.equal(sendCalls(h).length, 1);
  assert.equal(launchCalls(h).length, 1);
  assert.equal(closeCalls(h).length, 0);
  const node = h.getRun().nodes[0];
  assert.equal(node.status, 'blocked');
  assert.match(node.runtimeMessage, /확인되지 않았습니다/);
  assert.ok(node.launchUncertain);
});

test('a refused focus types nothing and leaves the stage for manual delivery', async () => {
  const h = harness();
  h.refuseNextFocus();
  await h.create(); await h.start();
  assert.equal(sendCalls(h).length, 0);
  assert.equal(h.getRun().nodes[0].status, 'blocked');
  assert.equal(h.getRun().jobs[0].promptRecovery, undefined);
  assert.equal(h.getRun().jobs[0].state, 'awaiting-report');
});

test('a worker restart before the ready signal resumes delivery once the run is resumed', async () => {
  let listed = false;
  const h = harness({ sleep: () => new Promise(() => {}), host: async (name) => name === 'agents.list' && !listed ? { agents: [] } : undefined });
  await h.create();
  await h.runtime.handlers['runs.start']({ runId: h.getRun().id });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launchCalls(h).length, 1);
  assert.equal(sendCalls(h).length, 0);
  h.runtime.dispose();
  const restarted = createRuntime({ orca: h.orca, now: () => NOW, sleep: async () => {}, fingerprint: async () => 'source-v1', ensureDirectory: async () => {},
    writeBrief: async () => {}, readReceipt: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  await restarted.initialize();
  await restarted.drain();
  assert.equal(sendCalls(h).length, 0, 'a paused run after restart types nothing on its own');
  listed = true;
  await restarted.handlers['runs.resume']({ runId: restarted.getState().runs[0].id });
  await restarted.drain();
  assert.equal(sendCalls(h).length, 1);
  assert.equal(launchCalls(h).length, 1);
  restarted.dispose();
});


// A turn is one prompt-to-idle cycle. Its outcome belongs to that turn only.
const turn = async (h, state, receivedAt, outcome) => {
  if (state === 'done') h.agents[0].state = 'done';
  if (state === 'working') h.agents[0].state = 'working';
  await h.events.get('agent.status.changed')({ terminalId: 't1', state, sessionId: 's1', receivedAt, ...(outcome ? { mainAgent: { outcome } } : {}) });
  await h.runtime.drain();
};
const continuationSends = (h) => sendCalls(h).filter((call) => /이전 턴이 오류로 중단됐습니다/.test(call.input.text));

test('a turn that dies of an error is continued once in the same terminal; the next successful turn and its report are accepted', async () => {
  const h = harness();
  await h.create(); await h.start();
  const job = h.currentJob();
  assert.equal(job.promptSeen, true);
  await turn(h, 'done', NOW + 10, 'failure');
  assert.equal(continuationSends(h).length, 1, 'the idle agent is asked to carry on');
  assert.equal(h.getRun().nodes[0].status, 'running', 'the stage is not blocked while it carries on');
  const current = h.getRun().jobs[0];
  assert.equal(current.promptRecovery.state, 'sent', 'a continuation never rewrites the one-shot prompt record');
  assert.equal(sendCalls(h).filter((call) => call.input.text.includes(job.nonce)).length, 1, 'the assignment itself is typed once');
  assert.match(h.getRun().events.map((event) => event.summary).join('\n'), /이어서/);
  await turn(h, 'working', NOW + 20);
  assert.equal(h.getRun().jobs[0].agentOutcome, undefined, 'a new turn starts without the old outcome');
  h.report(job);
  await turn(h, 'done', NOW + 30, 'success');
  assert.equal(h.getRun().jobs[0].agentOutcome, 'success');
  assert.equal(h.currentJob().phase, 'review');
  assert.equal(launchCalls(h).length, 2);
});

test('a passing report from the turn that ended in failure is still refused', async () => {
  const h = harness({ receiptWrittenAt: async () => NOW + 5 });
  await h.create(); await h.start();
  await h.runtime.handlers['runs.pause']({ runId: h.getRun().id });
  const job = h.currentJob();
  h.report(job);
  await turn(h, 'done', NOW + 10, 'failure');
  assert.equal(h.getRun().nodes[0].status, 'blocked');
  assert.match(h.getRun().nodes[0].runtimeMessage, /일치하지 않습니다/);
  await h.runtime.handlers['runs.refresh']({ runId: h.getRun().id });
  assert.equal(h.getRun().nodes[0].status, 'blocked');
});

test('a stored failure followed by a report written later by hand is accepted by an ordinary refresh', async () => {
  const written = { at: null };
  const h = harness({ receiptWrittenAt: async () => written.at });
  await h.create(); await h.start();
  await h.runtime.handlers['runs.pause']({ runId: h.getRun().id }); // no automatic continuation: the record stays as stored
  const job = h.currentJob();
  await turn(h, 'done', NOW + 10, 'failure');
  assert.equal(h.getRun().nodes[0].status, 'blocked');
  assert.match(h.getRun().nodes[0].runtimeMessage, /오류/);
  assert.doesNotMatch(h.getRun().nodes[0].runtimeMessage, /^에이전트가 종료됐지만 검증 보고서가 없습니다/);
  const stored = h.getRun().jobs[0];
  assert.deepEqual([stored.agentOutcome, stored.agentState], ['failure', 'done']);
  h.report(job); // the user continued the agent by hand; it wrote the report hours later
  written.at = NOW + 3 * 3600_000;
  await h.runtime.handlers['runs.refresh']({ runId: h.getRun().id });
  assert.equal(h.getRun().nodes[0].status, 'review');
  assert.equal(h.getRun().nodes[0].report.outcome, 'passed');
});

test('a refresh does not import a report while the agent is still working', async () => {
  const h = harness({ receiptWrittenAt: async () => NOW + 3 * 3600_000 });
  await h.create(); await h.start();
  await h.runtime.handlers['runs.pause']({ runId: h.getRun().id });
  const job = h.currentJob();
  await turn(h, 'done', NOW + 10, 'failure');
  h.report(job);
  h.agents[0].state = 'working';
  await h.runtime.handlers['runs.refresh']({ runId: h.getRun().id });
  assert.notEqual(h.getRun().nodes[0].status, 'review');
});

test('continuations are bounded with growing waits and then block naming the repeated error', async () => {
  const waits = [];
  const h = harness({ sleep: async (ms) => { waits.push(ms); } });
  await h.create(); await h.start();
  for (let index = 0; index < 4; index++) {
    await turn(h, 'working', NOW + 100 * index + 1);
    await turn(h, 'done', NOW + 100 * index + 2, 'failure');
  }
  assert.equal(continuationSends(h).length, 3);
  const backoff = waits.filter((ms) => ms >= 10_000 && ms !== 45_000);
  assert.deepEqual(backoff, [...backoff].sort((a, b) => a - b));
  assert.equal(new Set(backoff).size, 3, 'each wait is longer than the last');
  const node = h.getRun().nodes[0];
  assert.equal(node.status, 'blocked');
  assert.match(node.runtimeMessage, /턴이 오류\(failure\)로 4번/);
  assert.doesNotMatch(node.runtimeMessage, /보고서가 없습니다\./);
  assert.equal(launchCalls(h).length, 1);
});

test('a successful turn resets the continuation budget', async () => {
  const h = harness();
  await h.create(); await h.start();
  await turn(h, 'done', NOW + 10, 'failure');
  await turn(h, 'working', NOW + 20);
  await turn(h, 'done', NOW + 30, 'failure');
  assert.equal(h.getRun().jobs[0].continuations, 2);
  await turn(h, 'working', NOW + 40);
  h.agents[0].state = 'working';
  await h.events.get('agent.status.changed')({ terminalId: 't1', state: 'waiting', sessionId: 's1', receivedAt: NOW + 50, mainAgent: { outcome: 'success' } });
  await h.runtime.drain();
  assert.equal(h.getRun().jobs[0].continuations, undefined);
});

test('no continuation is typed when the run is paused, a report exists, the agent is busy, or the delivery itself is uncertain', async () => {
  const paused = harness();
  await paused.create(); await paused.start();
  await paused.runtime.handlers['runs.pause']({ runId: paused.getRun().id });
  await turn(paused, 'done', NOW + 10, 'failure');
  assert.equal(continuationSends(paused).length, 0);
  assert.match(paused.getRun().nodes[0].runtimeMessage, /일시 정지/);

  const reported = harness({ receiptWrittenAt: async () => NOW + 60_000 });
  await reported.create(); await reported.start();
  reported.report(reported.currentJob());
  await turn(reported, 'done', NOW + 10, 'failure');
  assert.equal(continuationSends(reported).length, 0);

  let busyAgents = null;
  const busy = harness({ host: async (name, _input, { agents }) => {
    if (name === 'agents.list' && busyAgents) return { agents: agents.map((agent) => ({ ...agent, state: 'working' })) };
  } });
  await busy.create(); await busy.start();
  busyAgents = true;
  await busy.events.get('agent.status.changed')({ terminalId: 't1', state: 'done', sessionId: 's1', receivedAt: NOW + 10, mainAgent: { outcome: 'failure' } });
  await busy.runtime.drain();
  assert.equal(continuationSends(busy).length, 0, 'an agent that is working again needs no nudge');

  const uncertain = harness({ host: async (name) => {
    if (name === 'terminal.sendText') throw Object.assign(new Error('response timeout'), { code: 'timeout' });
  } });
  await uncertain.create(); await uncertain.start();
  await turn(uncertain, 'working', NOW + 5);
  await turn(uncertain, 'done', NOW + 10, 'failure');
  assert.equal(sendCalls(uncertain).length, 1, 'nothing more is typed after an uncertain delivery');
});

test('an outcome-less status after a failed turn keeps the failure; only a new turn clears it', async () => {
  const h = harness();
  await h.create(); await h.start();
  await h.runtime.handlers['runs.pause']({ runId: h.getRun().id });
  await turn(h, 'done', NOW + 10, 'failure');
  await h.events.get('agent.status.changed')({ terminalId: 't1', state: 'waiting', sessionId: 's1', receivedAt: NOW + 20 });
  await h.runtime.drain();
  assert.equal(h.getRun().jobs[0].agentOutcome, 'failure');
  await turn(h, 'working', NOW + 30);
  assert.equal(h.getRun().jobs[0].agentOutcome, undefined);
});

test('a record stored before turn tracking (sticky failure, no failure time) is judged on its report once the agent is idle', async () => {
  const h = harness();
  await h.create(); await h.start();
  await h.runtime.handlers['runs.pause']({ runId: h.getRun().id });
  const job = h.currentJob();
  await turn(h, 'done', NOW + 10, 'failure');
  h.report(job);
  // Shape of the real stored record: the old code kept 'failure' through a later successful turn
  // whose events moved lastAgentEventAt past the report's file time, and recorded no failure time.
  const saved = savedState(h.store);
  const stored = saved.runs[0].jobs[0];
  delete stored.failedAt;
  Object.assign(stored, { agentOutcome: 'failure', agentState: 'done', lastAgentEventAt: NOW + 30 });
  saved.runs[0].status = 'blocked'; // as stored: blocked, not paused
  writeSaved(h.store, saved);
  h.runtime.dispose();
  const restarted = createRuntime({
    orca: h.orca, now: () => NOW, sleep: async () => {}, fingerprint: async () => 'source-v1', ensureDirectory: async () => {}, writeBrief: async () => {},
    readReceipt: async (file) => {
      if (!h.receipts.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return structuredClone(h.receipts.get(file));
    },
    validateArtifact: async (evidence) => ({ ...evidence, sha256: 'artifact-hash', size: 20 }),
    receiptWrittenAt: async () => NOW + 20
  });
  await restarted.initialize();
  await restarted.drain();
  // A restart pauses new assignments even for a run its startup check made runnable again.
  assert.equal(restarted.getState().runs[0].status, 'paused');
  assert.equal(launchCalls(h).length, 1);
  await restarted.handlers['runs.refresh']({ runId: restarted.getState().runs[0].id });
  await restarted.drain();
  assert.equal(restarted.getState().runs[0].nodes[0].status, 'review');
  assert.equal(launchCalls(h).length, 1, 'refresh imports the result without assigning new work while paused');
  restarted.dispose();
});


// Orca runs agent.launch.before inside agent.launch; this host stand-in does the same.
function hookedHarness({ hook = true, command = (agent) => agent, visual } = {}) {
  const overrides = createLaunchOverrides();
  const spawned = [];
  const h = harness({
    launchOverrides: overrides,
    visualAdvisor: visual ?? { advise: async ({ node }) => node.id === 'design' ? { stage: 'design', art: { pixel: true, source: 'goal' },
      skills: [{ name: 'pixel-art-studio', why: 'HUD·메뉴 UI 킷 시안', description: 'Creates pixel art.' }], launch: { model: 'gpt-6.2-sol', effort: 'high', source: 'default' } } : null },
    host: async (name, input) => {
      if (name !== 'agent.launch') return undefined;
      // Orca's hook events carry its internal worktree id, not the plugin's workspace id.
      const event = { agent: input.agent, workspaceId: 'repo-1::/repo/worktree', command: command(input.agent), env: {} };
      spawned.push(hook ? (overrides.handle(event, (next) => next) ?? event).command : event.command);
      return undefined;
    }
  });
  return { h, spawned };
}
const designStage = [{ id: 'design', title: '화면·상호작용 설계', deps: [], write: false }];

test('a codex design stage launches through the host API without a model and Orca\'s launch hook adds gpt-6.2-sol high', async () => {
  const { h, spawned } = hookedHarness();
  await h.create(designStage, { assignments: { design: { agent: 'codex' } } });
  await h.start();
  assert.deepEqual(Object.keys(launchCalls(h)[0].input).sort(), ['agent', 'workspaceId']);
  assert.deepEqual(spawned, ['codex -m gpt-6.2-sol -c model_reasoning_effort=high']);
  const job = h.currentJob();
  assert.deepEqual(job.launchSettings, { model: 'gpt-6.2-sol', effort: 'high', source: 'default', applied: true });
  assert.deepEqual(h.getRun().nodes[0].launchSettings, job.launchSettings);
  assert.match(h.getRun().events.map((event) => event.summary).join('\n'), /gpt-6\.2-sol/);
  assert.match(sendCalls(h)[0].input.text, /pixel-art-studio/);
  assert.match(sendCalls(h)[0].input.text, /실제 이미지 파일/);
  assert.equal(h.getRun().nodes[0].visualShortlist.skills[0].name, 'pixel-art-studio');
});

test('when the hook does not run, the stage still starts and says the model was not applied', async () => {
  const { h, spawned } = hookedHarness({ hook: false });
  await h.create(designStage, { assignments: { design: { agent: 'codex' } } });
  await h.start();
  assert.deepEqual(spawned, ['codex']);
  const settings = h.currentJob().launchSettings;
  assert.equal(settings.applied, false);
  assert.match(settings.reason, /hook/);
  assert.match(h.getRun().events.map((event) => event.summary).join('\n'), /적용하지 못했습니다/);
  assert.equal(sendCalls(h).length, 1);
});

test('stages without model fields and review launches leave the agent command alone', async () => {
  const { h, spawned } = hookedHarness();
  await h.create();
  await h.start();
  assert.deepEqual(spawned, ['codex']);
  assert.equal(h.currentJob().launchSettings, undefined);
  h.report(); await h.done();
  assert.equal(h.currentJob().phase, 'review');
  assert.deepEqual(spawned, ['codex', 'codex']);
});

test('assignments accept a model and effort per stage, reject unsafe values and clear with an empty value', async () => {
  const h = harness();
  await h.create();
  const runId = h.getRun().id;
  const set = await h.runtime.handlers['runs.updateAssignments']({ runId, assignments: { build: { model: 'gpt-6.2-sol', effort: 'xhigh' } } });
  assert.deepEqual([set.nodes[0].model, set.nodes[0].effort], ['gpt-6.2-sol', 'xhigh']);
  const before = h.runtime.getState();
  for (const bad of [{ model: 'x; rm' }, { effort: 'extreme' }]) {
    await assert.rejects(h.runtime.handlers['runs.updateAssignments']({ runId, assignments: { build: bad } }), /모델|추론/);
    assert.deepEqual(h.runtime.getState(), before);
  }
  const cleared = await h.runtime.handlers['runs.updateAssignments']({ runId, assignments: { build: { model: '', effort: '' } } });
  assert.equal(Object.hasOwn(cleared.nodes[0], 'model'), false);
  assert.equal(Object.hasOwn(cleared.nodes[0], 'effort'), false);
  const state = await h.runtime.handlers['state.get']();
  assert.deepEqual(state.launchOptions.visualDefault, { model: 'gpt-6.2-sol', effort: 'high' });
});


test('a report blocked only because it honestly lists a failed first try is accepted by an ordinary refresh and the review is assigned', async () => {
  const h = harness();
  await h.create(); await h.start();
  const job = h.currentJob();
  // First the report is refused for exactly this reason: a failed command offered as the check.
  h.report(job, { evidence: [{ kind: 'command', command: "ffmpeg -vf 'drawtext…'", exitCode: 8, role: 'check' }, { kind: 'artifact', path: job.receiptDirectory + '/research.md' }] });
  await h.done(job);
  assert.equal(h.getRun().nodes[0].status, 'running');
  assert.match(h.getRun().nodes[0].runtimeMessage, /실패한 명령을 통과 근거로 사용할 수 없습니다/);
  // The stored report as written in the real run: the failure is history, the rerun succeeded.
  h.report(job, { evidence: [
    { kind: 'command', command: "ffmpeg -vf 'drawtext…' (drawtext 필터 없음으로 실패, 재실행)", exitCode: 8 },
    { kind: 'command', command: "ffmpeg -vf 'fps=1/N,tile=8x2'", exitCode: 0 },
    { kind: 'artifact', path: job.receiptDirectory + '/research.md' }] });
  await h.runtime.handlers['runs.refresh']({ runId: h.getRun().id });
  await h.runtime.drain();
  assert.equal(h.getRun().nodes[0].status, 'review');
  assert.equal(h.currentJob().phase, 'review');
  assert.equal(launchCalls(h).length, 2);
});

test('the brief documents how to record a failed attempt without hiding it', () => {
  const run = { id: 'r', goal: '앱', workspacePath: '/repo', nodes: [] };
  const node = { id: 'research', title: '조사', deps: [], write: false, report: null };
  const prompt = buildNodePrompt(run, node, { runId: 'r', nodeId: 'research', nonce: 'n', phase: 'work', attempt: 1, agent: 'codex', receiptDirectory: '/p', receiptPath: '/p/result.json' });
  assert.match(prompt, /"role": ?"history"/);
});


// ---------- autonomous runs ----------
const notices = (h) => h.calls.filter((call) => call.name === 'notifications.show');
const auto = (h, nodes = [{ id: 'build', title: '앱 구현', deps: [], write: true }], extras = {}) => h.create(nodes, { autonomous: true, ...extras });
async function failReview(h) {
  h.report(); await h.done();
  h.report(h.currentJob(), { outcome: 'failed', summary: '검토 실패: 저장 버튼이 반응하지 않음' }); await h.done();
}

test('new runs are autonomous unless asked otherwise, and a run can be switched either way', async () => {
  const h = harness();
  await h.runtime.initialize();
  const created = await h.runtime.handlers['runs.create']({ goal: '앱', projectId: 'p1', nodes: [{ id: 'build', title: 'b', deps: [], write: true }] });
  assert.equal(created.autonomous, true);
  const manual = await h.runtime.handlers['runs.setAutonomous']({ runId: created.id, enabled: false });
  assert.equal(manual.autonomous, false);
  assert.match(manual.events.at(-1).summary, /자율 진행/);
  await assert.rejects(h.runtime.handlers['runs.setAutonomous']({ runId: created.id, enabled: 'yes' }), /enabled/);
});

test('an autonomous brief says up front that no person is available; a manual one does not', () => {
  const node = { id: 'build', title: '구현', deps: [], write: true, report: null };
  const job = { runId: 'r', nodeId: 'build', nonce: 'n', phase: 'work', attempt: 1, agent: 'codex', receiptDirectory: '/p', receiptPath: '/p/result.json' };
  const prompt = buildNodePrompt({ id: 'r', goal: '앱', workspacePath: '/repo', nodes: [], autonomous: true }, node, job);
  assert.ok(prompt.indexOf(AUTONOMY_BRIEF) > 0 && prompt.indexOf(AUTONOMY_BRIEF) < prompt.indexOf('실행 범위'));
  assert.doesNotMatch(buildNodePrompt({ id: 'r', goal: '앱', workspacePath: '/repo', nodes: [] }, node, job), /사람이 없습니다/);
});

test('a stage whose review failed past its attempts gets a fresh attempt on its own with the failure in the brief', async () => {
  const h = harness();
  await auto(h, undefined, { maxAttempts: 1 });
  await h.start();
  await failReview(h);
  assert.equal(launchCalls(h).length, 3, 'work, review, then a fresh work attempt');
  assert.match(sendCalls(h).at(-1).input.text, /저장 버튼이 반응하지 않음/);
  assert.match(h.getRun().events.map((event) => event.summary).join('\n'), /자율 진행: build 단계를 새로 시도합니다 \(단계 1\/3, 실행 1\/12/);
  assert.equal(h.getRun().autonomy.retries.build, 1);
});

test('repeated failures by one agent switch the stage to the other agent, then the stage limit stops the run with a notification', async () => {
  const h = harness();
  await auto(h, [{ id: 'build', title: '앱 구현', deps: [], write: true, agent: 'claude' }], { maxAttempts: 1 });
  await h.start();
  for (let round = 0; round < 3; round++) await failReview(h);
  assert.equal(h.getRun().nodes[0].agent, 'codex', 'switched after two retries on claude');
  assert.equal(launchCalls(h).filter((call) => call.input.agent === 'codex' && call.input === launchCalls(h).at(-1).input).length, 1);
  await failReview(h);
  assert.equal(h.getRun().nodes[0].status, 'failed');
  assert.equal(notices(h).length, 1);
  assert.match(notices(h)[0].input.body, /3번 다시 시도/);
  assert.match(notices(h)[0].input.body, /claude → codex/);
  const launches = launchCalls(h).length;
  await h.runtime.handlers['runs.refresh']({ runId: h.getRun().id }); await h.runtime.drain();
  assert.equal(launchCalls(h).length, launches);
  assert.equal(notices(h).length, 1, 'notified once');
});

test('an uncertain delivery is never retried on its own; it stops with a notification', async () => {
  const h = harness({ host: async (name) => { if (name === 'terminal.sendText') throw Object.assign(new Error('timeout'), { code: 'timeout' }); } });
  await auto(h);
  await h.start();
  assert.equal(launchCalls(h).length, 1);
  assert.equal(notices(h).length, 1);
  assert.match(notices(h)[0].input.body, /불명확/);
});

test('an internal gate is approved for preparation on the evidence of passed reviews; no submission is ever set', async () => {
  const h = harness();
  await auto(h, [{ id: 'listing', title: '스토어 자료', deps: [], write: false }, { id: 'internal', title: '내부 테스트', deps: ['listing'], write: true, requiresApproval: true }]);
  await h.start();
  h.report(); await h.done(); h.report(); await h.done();
  const gate = h.getRun().nodes[1];
  assert.match(gate.approval.note, /자율 진행/);
  assert.equal(gate.approval.submission, undefined);
  assert.equal(h.currentJob().nodeId, 'internal');
  assert.match(sendCalls(h).at(-1).input.text, /실제 앱 스토어 제출\/배포는 하지 마세요/);
});

test('a clean turn that ends without a report is told to decide for itself, twice at most, then the stage is retried', async () => {
  const h = harness();
  await auto(h, undefined, { maxAttempts: 1 });
  await h.start();
  for (let turn = 1; turn <= 3; turn++) {
    await h.events.get('agent.status.changed')({ terminalId: 't1', state: 'working', receivedAt: NOW + turn * 10 });
    h.agents[0].state = 'done';
    await h.events.get('agent.status.changed')({ terminalId: 't1', state: 'done', receivedAt: NOW + turn * 10 + 5, mainAgent: { outcome: 'success' } });
    await h.runtime.drain();
  }
  assert.equal(sendCalls(h).filter((call) => call.input.text === DECIDE_PROMPT).length, 2);
  assert.equal(launchCalls(h).length, 2, 'after the bound the stage gets a fresh attempt');
});

test('after a worker restart an autonomous run continues on its own and never relaunches a possibly live job', async () => {
  const h = harness();
  await auto(h, [{ id: 'research', title: '조사', deps: [], write: false }, { id: 'brief', title: '기획', deps: ['research'], write: false }]);
  await h.start();
  const job = h.currentJob();
  h.runtime.dispose();
  const restarted = createRuntime({ orca: h.orca, gitState: null, now: () => NOW, sleep: async () => {}, fingerprint: async () => 'source-v1', ensureDirectory: async () => {}, writeBrief: async () => {},
    readReceipt: async (file) => { if (!h.receipts.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return structuredClone(h.receipts.get(file)); },
    validateArtifact: async (evidence) => ({ ...evidence, sha256: 'x', size: 1 }) });
  await restarted.initialize(); await restarted.drain();
  assert.notEqual(restarted.getState().runs[0].status, 'paused');
  assert.equal(launchCalls(h).length, 1, 'the live job is not launched again');
  h.report(job);
  h.agents[0].state = 'done';
  await h.events.get('agent.status.changed')({ terminalId: job.terminalId, state: 'done', sessionId: 's', mainAgent: { outcome: 'success' } });
  await restarted.drain();
  assert.equal(launchCalls(h).length, 2, 'the review starts without anyone pressing resume');
  restarted.dispose();
});

test('a finished autonomous run is announced once; a permission prompt is announced once', async () => {
  const h = harness();
  await auto(h);
  await h.start();
  await h.events.get('agent.status.changed')({ terminalId: 't1', state: 'blocked', receivedAt: NOW + 1 });
  await h.events.get('agent.status.changed')({ terminalId: 't1', state: 'working', receivedAt: NOW + 2 });
  await h.events.get('agent.status.changed')({ terminalId: 't1', state: 'blocked', receivedAt: NOW + 3 });
  await h.runtime.drain();
  assert.equal(notices(h).filter((call) => /권한|로그인/.test(call.input.body)).length, 1);
  h.report(); await h.done(); h.report(); await h.done();
  assert.equal(h.getRun().status, 'completed');
  await h.runtime.handlers['runs.refresh']({ runId: h.getRun().id }); await h.runtime.drain();
  const finished = notices(h).filter((call) => /실행 완료/.test(call.input.title));
  assert.equal(finished.length, 1);
  assert.match(finished[0].input.body, /구현 완료/, 'the notice names what actually finished');
});

// Storage: one value per run (src/store.mjs); a failed write never stops the run.
const restartRuntime = (h, extra = {}) => createRuntime({ orca: h.orca, gitState: null, now: () => NOW, sleep: async () => {}, fingerprint: async () => 'source-v1', ensureDirectory: async () => {}, writeBrief: async () => {},
  readReceipt: async (file) => { if (!h.receipts.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return structuredClone(h.receipts.get(file)); },
  validateArtifact: async (evidence) => ({ ...evidence, sha256: 'x', size: 1 }), ...extra });

test('a failed save keeps serving events from memory, warns on the run and in state.get, and recovers', async () => {
  let failing = false;
  const h = harness({ failWrites: () => failing });
  await auto(h);
  await h.start();
  await turn(h, 'working', NOW + 1);
  failing = true;
  h.report();
  await h.done();
  assert.equal(h.getRun().jobs[0].state, 'complete', 'the report is taken in from memory although nothing could be saved');
  assert.equal(h.getRun().nodes[0].status, 'review');
  assert.equal(launchCalls(h).length, 1, 'no review is launched while its intent cannot be saved');
  assert.equal(h.getRun().jobs.length, 1, 'the unsaved claim was undone, not left behind');
  assert.match(h.getRun().storageWarning.message, /Orca could not complete/);
  assert.match(h.posts.at(-1).value.runs[0].storageWarning.message, /Orca could not complete/, 'the panel hears about it');
  assert.match((await h.runtime.handlers['state.get']({ view: 'summary' })).warnings.join(' '), /저장하지 못했습니다/);
  assert.equal(notices(h).filter((call) => /저장하지 못했습니다/.test(call.input.title)).length, 1);
  failing = false;
  await h.runtime.handlers['runs.refresh']({ runId: h.getRun().id }); await h.runtime.drain();
  assert.equal(h.getRun().storageWarning, undefined);
  assert.equal(launchCalls(h).length, 2, 'the review starts once a save succeeds');
  assert.equal(savedState(h.store).runs[0].jobs[0].state, 'complete', 'the next write carries everything done meanwhile');
  assert.equal((await h.runtime.handlers['state.get']({ view: 'summary' })).warnings.some((line) => /저장/.test(line)), false);
});

test('a launch is never started when its intent cannot be saved', async () => {
  const h = harness({ failWrites: (key) => key.startsWith('toris-neon.run.') && h.runtime.getState().runs[0]?.jobs?.some((job) => job.state === 'launching') });
  await auto(h);
  await h.start();
  assert.equal(launchCalls(h).length, 0);
  assert.match(h.getRun().storageWarning.message, /Orca could not complete/);
  assert.equal(h.getRun().nodes[0].active, null, 'the claim is undone');
  assert.equal(h.getRun().nodes[0].attempts, 0, 'no attempt is spent on a launch that never happened');
  assert.equal(h.getRun().jobs.length, 0);
});

test('a run frozen in the old single value restarts from it, migrates, and takes in the finished report', async () => {
  const h = harness();
  await auto(h);
  await h.start();
  await turn(h, 'working', NOW + 1);
  const job = h.currentJob();
  const saved = savedState(h.store);
  h.runtime.dispose();
  // What the old worker left: one value stuck at 'working' while the agent finished and wrote its report.
  h.store.clear();
  h.store.set(LEGACY_KEY, { version: 1, revision: saved.revision, runs: saved.runs, archivedRuns: [] });
  h.report(job);
  h.agents[0].state = 'done';
  const restarted = restartRuntime(h);
  await restarted.initialize(); await restarted.drain();
  assert.equal(h.store.has(LEGACY_KEY), false);
  assert.equal(savedState(h.store).runs[0].jobs.find((entry) => entry.nonce === job.nonce).state, 'complete');
  assert.equal(launchCalls(h).length, 2, 'the review starts without anyone pressing anything');
  restarted.dispose();
});

test('the periodic watch takes in a report whose done event never arrived', async () => {
  const h = harness();
  await auto(h);
  await h.start();
  await turn(h, 'working', NOW + 1);
  h.report();
  h.agents[0].state = 'done'; // no event
  await h.runtime.watchTick(); await h.runtime.drain();
  assert.equal(launchCalls(h).length, 2);
  assert.equal(h.getRun().jobs[0].state, 'complete');
});

test('the periodic watch calls for attention when an agent waits on a prompt for minutes, once and without typing', async () => {
  let clock = NOW;
  const h = harness({ now: () => clock });
  await h.create(); await h.start();
  await turn(h, 'working', NOW + 1);
  Object.assign(h.agents[0], { state: 'waiting', stateStartedAt: NOW + 2 });
  await h.events.get('agent.status.changed')({ terminalId: 't1', state: 'waiting', receivedAt: NOW + 2 });
  await h.runtime.drain();
  const typed = sendCalls(h).length;
  clock = NOW + 5 * 60_000;
  await h.runtime.watchTick(); await h.runtime.drain();
  await h.runtime.watchTick(); await h.runtime.drain();
  assert.equal(notices(h).filter((call) => /확인/.test(call.input.title)).length, 1);
  assert.match(h.getRun().nodes[0].runtimeMessage, /4분째/);
  assert.equal(sendCalls(h).length, typed, 'nothing is typed into a waiting prompt');
});

test('a restart seconds after typing leaves the delivery check to decide instead of blocking and relaunching', async () => {
  const h = harness();
  await auto(h);
  await h.start();
  const saved = savedState(h.store);
  const job = saved.runs[0].jobs[0];
  // Stored just after typing: sent, no turn seen yet, the agent still idle at its prompt.
  Object.assign(job, { promptSeen: false, agentState: 'done' });
  delete saved.runs[0].nodes[0].deliveryRetries;
  writeSaved(h.store, saved);
  h.agents[0].state = 'done';
  h.runtime.dispose();
  const restarted = restartRuntime(h, { sleep: () => new Promise(() => {}) }); // the 45 s check is still pending
  await restarted.initialize(); await restarted.flush();
  const after = restarted.getState().runs[0];
  assert.equal(after.jobs.length, 1, 'nothing superseded');
  assert.equal(after.jobs[0].state, 'running');
  assert.equal(after.nodes[0].status, 'running');
  assert.equal(launchCalls(h).length, 1, 'no relaunch');
  restarted.dispose();
});

const badCheck = (job) => ({ evidence: [{ kind: 'command', command: 'diff 1-work/brief.md 3-work/brief.md', exitCode: 1, role: 'check' }, { kind: 'artifact', path: job.receiptDirectory + '/verification.md' }] });
const fixRequests = (h) => sendCalls(h).filter((call) => /보고서만 고쳐/.test(call.input.text));

test('a report refused for its form goes back to the same agent to fix; the stage is not redone', async () => {
  const h = harness();
  await auto(h); await h.start();
  await turn(h, 'working', NOW + 1);
  const job = h.currentJob();
  h.report(job, badCheck(job));
  await h.done(job);
  assert.equal(launchCalls(h).length, 1, 'no new attempt');
  assert.equal(h.getRun().nodes[0].active.nonce, job.nonce, 'the stage stays with this agent');
  const [fix] = fixRequests(h);
  assert.equal(fix.input.terminalId, job.terminalId);
  assert.match(fix.input.text, /evidence\[0\]/);
  assert.match(fix.input.text, /expectedExitCode/);
  assert.match(fix.input.text, /result\.json/);
  await turn(h, 'working', NOW + 5);
  h.report(job, { evidence: [{ kind: 'command', command: 'diff 1-work/brief.md 3-work/brief.md', exitCode: 1, expectedExitCode: 1, role: 'check' }, { kind: 'artifact', path: job.receiptDirectory + '/verification.md' }] });
  await turn(h, 'done', NOW + 6, 'success');
  assert.equal(h.getRun().jobs[0].state, 'complete');
  assert.equal(launchCalls(h).length, 2, 'the review starts after the corrected report');
});

test('report fixes are bounded; after two the stage falls back to the usual block and retry', async () => {
  const h = harness();
  await h.create(); await h.start();
  await turn(h, 'working', NOW + 1);
  const job = h.currentJob();
  h.report(job, badCheck(job));
  await h.done(job);
  for (const at of [NOW + 10, NOW + 20]) { await turn(h, 'working', at); await turn(h, 'done', at + 1, 'success'); }
  assert.equal(fixRequests(h).length, 2);
  assert.equal(h.getRun().nodes[0].status, 'blocked');
  assert.match(h.getRun().nodes[0].runtimeMessage, /evidence\[0\]/);
});

test('a report written minutes ago is taken in although Orca still says the agent is working', async () => {
  let clock = NOW;
  const h = harness({ now: () => clock, receiptWrittenAt: async () => NOW + 60_000 });
  await auto(h); await h.start();
  await turn(h, 'working', NOW + 1);
  h.report(); // Orca never reports done
  clock = NOW + 60_000 + 3 * 60_000 + 1000;
  await h.runtime.watchTick(); await h.runtime.drain();
  assert.equal(h.getRun().jobs[0].state, 'complete');
  assert.equal(launchCalls(h).length, 2);
});

test('a turn that ended without a report and was never nudged is nudged by the watch', async () => {
  let clock = NOW;
  const h = harness({ now: () => clock });
  await auto(h); await h.start();
  await turn(h, 'working', NOW + 1);
  // The done arrives while agents.list still says working, so the decision nudge stands down.
  await h.events.get('agent.status.changed')({ terminalId: 't1', state: 'done', receivedAt: NOW + 3 });
  await h.runtime.drain();
  assert.equal(sendCalls(h).filter((call) => call.input.text === DECIDE_PROMPT).length, 0);
  Object.assign(h.agents[0], { state: 'done', stateStartedAt: NOW + 3 });
  clock = NOW + 4 * 60_000;
  await h.runtime.watchTick(); await h.runtime.drain();
  assert.equal(sendCalls(h).filter((call) => call.input.text === DECIDE_PROMPT).length, 1);
});

test('each job carries its stage budget and the brief states it; document reviews record follow-ups', async () => {
  const h = harness();
  await h.create([{ id: 'research', title: '조사', deps: [], write: false }]); await h.start();
  const job = h.currentJob();
  assert.equal(job.budgetMinutes, STAGE_BUDGETS.research.work);
  const run = h.getRun();
  const work = buildNodePrompt(run, run.nodes[0], job);
  assert.match(work, new RegExp('약 ' + STAGE_BUDGETS.research.work + '분'));
  assert.match(work, /expectedExitCode/);
  const review = buildNodePrompt(run, run.nodes[0], { ...job, phase: 'review' });
  assert.match(review, /followUps/);
  assert.match(review, /차단/);
});

// Terminal cleanup (src/cleanup.mjs): finished jobs' terminals close after a grace period.
const closedTerminals = (h) => h.calls.filter((call) => call.name === 'terminal.close').map((call) => call.input.terminalId);

test('the terminal of an accepted job closes after the grace period and the event names its session', async () => {
  let clock = NOW;
  const h = harness({ now: () => clock });
  await auto(h); await h.start();
  const job = h.currentJob();
  h.report(job); await h.done(job);
  const review = h.currentJob();
  await h.runtime.cleanupTick(); await h.runtime.drain();
  assert.deepEqual(closedTerminals(h), [], 'not before the grace period');
  clock = NOW + 3 * 60_000;
  await h.runtime.cleanupTick(); await h.runtime.drain();
  assert.deepEqual(closedTerminals(h), [job.terminalId], 'the review terminal (current job) stays open');
  const stored = h.getRun().jobs.find((entry) => entry.nonce === job.nonce);
  assert.equal(stored.terminalClosed.sessionId, 'session-' + job.terminalId);
  assert.match(h.getRun().events.at(-1).summary, new RegExp('session-' + job.terminalId));
  await h.runtime.cleanupTick(); await h.runtime.drain();
  assert.deepEqual(closedTerminals(h), [job.terminalId], 'closed once');
  assert.notEqual(review.terminalId, job.terminalId);
});

test('a run with the switch off keeps its finished terminals', async () => {
  let clock = NOW;
  const h = harness({ now: () => clock });
  await auto(h); await h.start();
  await h.runtime.handlers['runs.setTerminalCleanup']({ runId: h.getRun().id, enabled: false });
  assert.equal(h.getRun().closeFinishedTerminals, false);
  h.report(); await h.done();
  clock = NOW + 10 * 60_000;
  await h.runtime.cleanupTick(); await h.runtime.drain();
  assert.deepEqual(closedTerminals(h), []);
  await assert.rejects(h.runtime.handlers['runs.setTerminalCleanup']({ runId: h.getRun().id, enabled: 'yes' }), /true 또는 false/);
});

test('the start sweep closes idle terminals of finished jobs, leaves a working one, and logs what it did', async () => {
  let clock = NOW;
  const logs = [];
  const h = harness({ now: () => clock });
  h.orca.log = (line) => logs.push(line);
  await auto(h, [{ id: 'research', title: '조사', deps: [], write: false }, { id: 'brief', title: '기획', deps: ['research'], write: false }]);
  await h.start();
  const work = h.currentJob();
  h.report(work); await h.done(work);
  const saved = savedState(h.store);
  // Two older finished jobs as the stored runs have them: one idle, one whose agent still works.
  saved.runs[0].jobs.push(
    { runId: saved.runs[0].id, nodeId: 'research', nonce: 'old-idle', phase: 'work', attempt: 1, agent: 'claude', state: 'superseded', terminalId: 'old-idle', sessionId: 's-old' },
    { runId: saved.runs[0].id, nodeId: 'research', nonce: 'old-busy', phase: 'work', attempt: 1, agent: 'claude', state: 'superseded', terminalId: 'old-busy' });
  writeSaved(h.store, saved);
  h.agents.push({ terminalId: 'old-idle', state: 'done' }, { terminalId: 'old-busy', state: 'working' });
  h.runtime.dispose();
  clock = NOW + 5 * 60_000;
  const restarted = restartRuntime(h, { now: () => clock });
  await restarted.initialize(); await restarted.drain();
  const closed = h.calls.filter((call) => call.name === 'terminal.close').map((call) => call.input.terminalId);
  assert.deepEqual(closed.sort(), [work.terminalId, 'old-idle'].sort());
  assert.match(logs.join('\n'), /닫음 2/);
  assert.match(logs.join('\n'), /old-busy.*working/);
  const busy = restarted.getState().runs[0].jobs.find((entry) => entry.nonce === 'old-busy');
  assert.equal(busy.terminalClosed, undefined);
  restarted.dispose();
});

test('the start sweep runs in the background; Orca\'s 10-second activation limit never waits on it', async () => {
  let clock = NOW;
  let hang = false;
  const h = harness({ now: () => clock, host: async (name) => (hang && name === 'terminal.list' ? new Promise(() => {}) : undefined) });
  await auto(h); await h.start();
  h.report(); await h.done();
  h.runtime.dispose();
  hang = true;
  clock = NOW + 5 * 60_000;
  const restarted = restartRuntime(h, { now: () => clock });
  const ready = await Promise.race([restarted.initialize().then(() => 'ready'), new Promise((resolve) => setTimeout(() => resolve('blocked'), 200))]);
  assert.equal(ready, 'ready');
  restarted.dispose();
});

// terminal.sendText errors that Orca throws before writing (src/delivery.mjs) are retried, never "uncertain".
test('a send refused before writing is retried after focusing again, and the prompt arrives once', async () => {
  let refusals = 1;
  const h = harness({ host: async (name) => {
    if (name === 'terminal.sendText' && refusals > 0) { refusals--; throw Object.assign(new Error('terminal_surface_ownership_unavailable'), { code: 'action_failed' }); }
  } });
  await auto(h); await h.start();
  const job = h.getRun().jobs[0];
  assert.equal(job.promptRecovery.state, 'sent');
  assert.equal(sendCalls(h).length, 2);
  assert.equal(h.calls.filter((call) => call.name === 'terminal.focus').length, 2, 'focused again before the retry');
  assert.equal(h.getRun().nodes[0].status, 'running');
  assert.match(h.getRun().events.map((event) => event.summary).join('\n'), /terminal_surface_ownership_unavailable.*다시 시도/);
});

test('a send that keeps being refused before writing is handled as undelivered: terminal closed and relaunched', async () => {
  let refusals = 3; // the first send and both retries of the first job; the relaunched job's send goes through
  const h = harness({ host: async (name) => {
    if (name === 'terminal.sendText' && refusals > 0) { refusals--; throw Object.assign(new Error('terminal_surface_ownership_unavailable'), { code: 'action_failed' }); }
  } });
  await auto(h); await h.start();
  const jobs = h.getRun().jobs;
  assert.equal(jobs[0].state, 'undelivered');
  assert.equal(jobs[0].promptRecovery, undefined, 'no uncertain record: nothing was typed');
  assert.ok(h.calls.some((call) => call.name === 'terminal.close' && call.input.terminalId === jobs[0].terminalId));
  assert.equal(launchCalls(h).length, 2);
  assert.equal(jobs[1].promptRecovery.state, 'sent');
});

// Improving an existing, shipped app (src/improve.mjs, src/catalog.mjs).
const improveInput = (extra = {}) => ({ template: 'improve', kind: 'feature', options: { payments: true }, goal: '알림 기능과 프리미엄 결제를 추가합니다.', projectId: 'p1', autonomous: false, ...extra });
const linkedApp = { accountId: 'acc-1', accountName: 'Toris', packageName: 'com.example.water', status: 'published', tracks: [{ track: 'production', versionCodes: [42], state: 'published' }], observedAt: '2026-11-22T00:00:00.000Z' };

test('an improvement flow is created from its kind\'s template and records the kind and the linked Play app', async () => {
  const h = harness({ readPlayApp: async ({ accountId, packageName }) => {
    if (accountId !== 'acc-1' || packageName !== 'com.example.water') throw Object.assign(new Error('이 계정에 등록된 패키지가 아닙니다.'), { code: 'invalid_input' });
    return linkedApp;
  } });
  await h.runtime.initialize();
  const run = await h.runtime.handlers['runs.create'](improveInput({ playLink: { accountId: 'acc-1', packageName: 'com.example.water' } }));
  assert.equal(run.template, 'improve');
  assert.deepEqual(run.nodes.map((node) => node.id), ['identity', 'plan', 'build', 'monetization', 'test', 'catalog']);
  assert.equal(run.improvement.kind, 'feature');
  assert.equal(run.improvement.playLink.packageName, 'com.example.water');
  assert.equal(run.nodes.find((node) => node.id === 'catalog').humanApproval, true);
  await assert.rejects(h.runtime.handlers['runs.create'](improveInput({ playLink: { accountId: 'acc-2', packageName: 'com.example.water' } })), /등록된 패키지/);
  await assert.rejects(h.runtime.handlers['runs.create'](improveInput({ kind: undefined })), /개선 종류/);
  await assert.rejects(h.runtime.handlers['runs.create']({ ...improveInput(), template: 'rewrite' }), /흐름 종류/);
  assert.equal(h.runtime.getState().runs.length, 1, 'refused inputs create nothing');
});

test('an improvement flow refuses a repository without commits', async () => {
  const h = harness({ inspectRepository: async () => ({ hasCommit: false, hasBase: false }) });
  await h.runtime.initialize();
  await assert.rejects(h.runtime.handlers['runs.create'](improveInput()), /커밋/);
  assert.equal(h.runtime.getState().runs.length, 0);
});

test('the product catalog is approved only by a person confirming every proposed product', async () => {
  const h = harness();
  await h.runtime.initialize();
  const created = await h.runtime.handlers['runs.create'](improveInput({ autonomous: true }));
  const saved = savedState(h.store);
  const stored = saved.runs[0];
  for (const node of stored.nodes) if (!['catalog', 'internal', 'release'].includes(node.id)) Object.assign(node, { status: 'passed', completedAt: '2026-11-23T00:00:00.000Z' });
  stored.nodes.find((node) => node.id === 'monetization').report = { outcome: 'passed', summary: '결제', products: [{ productId: 'premium_unlock', type: 'inapp', price: '₩3,900' }] };
  stored.nodes.find((node) => node.id === 'catalog').status = 'awaiting-approval';
  stored.autonomy = { stopped: { at: '2026-11-23T00:00:00.000Z', reason: 'Play Console에서 상품을 만드세요.' }, notified: ['human-approval:catalog'] };
  writeSaved(h.store, saved);
  h.runtime.dispose();
  const restarted = restartRuntime(h);
  await restarted.initialize();
  const base = { runId: created.id, nodeId: 'catalog', note: 'Play Console에 premium_unlock을 만들고 활성화했습니다.' };
  await assert.rejects(restarted.handlers['runs.approve'](base), /상품/);
  await assert.rejects(restarted.handlers['runs.approve']({ ...base, productCatalog: { confirmed: [] } }), /premium_unlock/);
  await assert.rejects(restarted.handlers['runs.approve']({ ...base, nodeId: 'internal', productCatalog: { confirmed: ['premium_unlock'] } }), /상품 등록/);
  const approved = await restarted.handlers['runs.approve']({ ...base, productCatalog: { confirmed: ['premium_unlock'] } });
  const catalog = approved.nodes.find((node) => node.id === 'catalog');
  assert.deepEqual(catalog.approval.productCatalog.products.map((item) => item.productId), ['premium_unlock']);
  assert.equal(approved.autonomy.stopped, undefined, 'the person acted; autonomy may continue');
  restarted.dispose();
});

// Bundle 1: custom instructions survive, writing stages commit, the summary says what runs and why stages wait.
test('custom stage instructions survive create, storage, a restart and reach the brief', async () => {
  const h = harness();
  await h.runtime.initialize();
  const created = await h.runtime.handlers['runs.create']({ goal: '앱', projectId: 'p1', autonomous: false,
    nodes: [{ id: 'build', title: '구현', deps: [], write: true, instructions: '설정 화면의 알림 토글만 고치세요.' }] });
  assert.equal(created.nodes[0].instructions, '설정 화면의 알림 토글만 고치세요.');
  assert.equal(savedState(h.store).runs[0].nodes[0].instructions, '설정 화면의 알림 토글만 고치세요.');
  h.runtime.dispose();
  const restarted = restartRuntime(h);
  await restarted.initialize();
  const run = restarted.getState().runs[0];
  const job = { runId: run.id, nodeId: 'build', nonce: 'n', phase: 'work', attempt: 1, agent: 'codex', receiptDirectory: '/r', receiptPath: '/r/result.json' };
  assert.match(buildNodePrompt(run, run.nodes[0], job), /실행 범위\/완료 조건: 설정 화면의 알림 토글만 고치세요\./);
  restarted.dispose();
});

test('a writing stage must leave its work committed: otherwise the agent is asked to commit, not failed', async () => {
  let git = { head: 'h0', clean: true, changed: [] };
  const h = harness({ gitState: async () => git });
  await h.create(); await h.start();
  await turn(h, 'working', NOW + 1);
  const job = h.currentJob();
  assert.equal(h.getRun().jobs[0].startHead, 'h0');
  git = { head: 'h0', clean: false, changed: ['lib/main.dart', 'test/app_test.dart'] };
  h.report(job); await h.done(job);
  assert.equal(h.getRun().nodes[0].status, 'running', 'not failed');
  const [fix] = sendCalls(h).filter((call) => /커밋/.test(call.input.text));
  assert.match(fix.input.text, /이 실행 브랜치에 커밋/);
  assert.match(fix.input.text, /lib\/main\.dart/);
  git = { head: 'h1', clean: true, changed: [] };
  await turn(h, 'working', NOW + 5); h.report(job); await turn(h, 'done', NOW + 6, 'success');
  assert.equal(h.getRun().jobs[0].state, 'complete');
  const review = h.currentJob();
  assert.equal(review.sourceCommit, 'h1', 'the review is tied to the commit');
  git = { head: 'h2', clean: true, changed: [] };
  h.report(review); await h.done(review);
  assert.notEqual(h.getRun().nodes[0].status, 'passed', 'a review of a commit that moved does not pass');
});

test('when git cannot be read, a writing stage is not accepted as committed', async () => {
  let fails = false;
  const h = harness({ gitState: async () => { if (fails) throw new Error('index.lock exists'); return { head: 'h0', clean: true, changed: [] }; } });
  await h.create(); await h.start();
  await turn(h, 'working', NOW + 1);
  const job = h.currentJob();
  fails = true;
  h.report(job); await h.done(job);
  const node = h.getRun().nodes[0];
  assert.notEqual(node.status, 'review', 'not passed on to review unchecked');
  assert.notEqual(node.status, 'passed');
  assert.match(JSON.stringify(h.getRun()), /git 상태를 읽지 못해[^"]*index\.lock/);
});

test('the summary says which code runs, the Neon-wide limits, why stages wait and what cleanup did', async () => {
  const h = harness({ buildInfo: { version: '0.2.0', commit: 'abc1234def', shortCommit: 'abc1234', dirty: false, channel: 'dev', error: null } });
  await h.create([{ id: 'build', title: '구현', deps: [], write: true }, { id: 'test', title: '테스트', deps: ['build'] }]);
  await h.start();
  const summary = await h.runtime.handlers['state.get']({ view: 'summary' });
  assert.equal(summary.build.label, 'v0.2.0 · abc1234 · 개발 폴더');
  assert.deepEqual(summary.limits, { activeJobs: 2, heavyJobs: 1, active: 1, heavy: 1 });
  assert.equal(summary.runs[0].waiting.test, '선행 단계 대기');
  assert.equal(h.posts.at(-1).value.build.label, 'v0.2.0 · abc1234 · 개발 폴더', 'pushed too');
});

test('the same request returns the run it already made, never a second one', async () => {
  const h = harness();
  await h.runtime.initialize();
  const first = await h.runtime.handlers['runs.create']({ goal: '앱', projectId: 'p1', requestId: 'bot-req-7', autonomous: false });
  const again = await h.runtime.handlers['runs.create']({ goal: '다른 문구', projectId: 'p1', requestId: 'bot-req-7', autonomous: false });
  assert.equal(again.id, first.id);
  assert.equal(again.requestId, 'req:bot-req-7');
  assert.equal(h.runtime.getState().runs.length, 1);
  await assert.rejects(h.runtime.handlers['runs.create']({ goal: '앱', projectId: 'p1', requestId: 'bad id!' }), /requestId/);
});

test('remote requests through the real runs.create: one run per request, conflicts and goal-only twins kept apart', async () => {
  // Arrange
  const h = harness();
  await h.runtime.initialize();
  const handlers = h.runtime.handlers;
  const remote = createRemoteControl({ getRuns: () => { const state = h.runtime.getState(); return [...state.runs, ...state.archivedRuns]; },
    createRun: handlers['runs.create'], startRun: handlers['runs.start'], resumeRun: handlers['runs.resume'] });
  const longest = { action: 'create', requestId: 'b'.repeat(70), mode: 'improve', kind: 'feature', projectId: 'p1', goal: '알림 기능을 추가합니다.' };

  // Act
  const first = await remote.request(longest);
  const again = await remote.request(longest);
  const twin = await remote.request({ ...longest, requestId: 'other-request' });
  await handlers['runs.cancel']({ runId: first.run.runId });
  const afterCancel = await remote.request(longest);

  // Assert
  assert.equal(again.run.runId, first.run.runId, 'the longest requestId still fits the runs.create key');
  assert.notEqual(twin.run.runId, first.run.runId);
  assert.equal(afterCancel.run.status, 'cancelled', 'a redelivery after cancelling does not make a new run');
  await assert.rejects(remote.request({ ...longest, goal: '결제를 추가합니다.' }), { code: 'conflict' });
  assert.equal(h.runtime.getState().runs.length, 2);
  assert.equal(first.run.kind, 'feature');
});

test('picking a diagnosis candidate creates one linked improvement run of the candidate\'s kind', async () => {
  const h = harness();
  await h.runtime.initialize();
  const diag = await h.runtime.handlers['runs.create']({ template: 'diagnose', projectId: 'p1', autonomous: false });
  assert.deepEqual(diag.nodes.map((node) => node.id), ['identity', 'diagnose']);
  const saved = savedState(h.store);
  const node = saved.runs[0].nodes.find((item) => item.id === 'diagnose');
  node.status = 'passed';
  node.report = { outcome: 'passed', summary: '후보', candidates: [{ kind: 'bugfix', title: '알림이 두 번 울림', problem: 'p', evidence: 'e', impact: 'i', scope: 's', verify: 'v' }] };
  writeSaved(h.store, saved);
  h.runtime.dispose();
  const restarted = restartRuntime(h);
  await restarted.initialize();
  const picked = await restarted.handlers['runs.create']({ fromDiagnosis: { runId: diag.id, index: 0 }, autonomous: false });
  assert.deepEqual(picked.nodes.map((item) => item.id), ['identity', 'reproduce', 'build', 'test']);
  assert.equal(picked.parentRunId, diag.id);
  assert.match(picked.goal, /알림이 두 번 울림/);
  const twice = await restarted.handlers['runs.create']({ fromDiagnosis: { runId: diag.id, index: 0 } });
  assert.equal(twice.id, picked.id, 'picking the same candidate again opens the existing run');
  restarted.dispose();
});

test('the summary shows the configured limits', async () => {
  const { projectState } = await import('../src/views.mjs');
  const summary = projectState({ version: 1, revision: 1, runs: [], archivedRuns: [] }, 'summary', { activeJobs: 3, heavyJobs: 2 });
  assert.deepEqual(summary.limits, { activeJobs: 3, heavyJobs: 2, active: 0, heavy: 0 });
});

test('token usage: the watch reads agent.listSessions once per active workspace, keeps it across a restart, and never fails a job', async () => {
  // Arrange: one live build job whose agent reported session s1.
  let total = 120_000;
  let failRead = false;
  const host = async (name, input) => {
    if (name !== 'agent.listSessions') return undefined;
    if (failRead) throw new Error('history unavailable');
    return { truncated: false, sessions: [
      { sessionId: 's1', agent: 'codex', hostId: 'local', workspaceId: input.workspaceId, createdAt: NOW + 5, updatedAt: NOW + 60_000, totalTokens: total, running: true, title: 'x', branch: null, messageCount: 3 },
      { sessionId: 'other', agent: 'codex', hostId: 'local', workspaceId: input.workspaceId, createdAt: NOW, updatedAt: NOW, totalTokens: 9_999_999, running: false, title: 'y', branch: null, messageCount: 1 },
    ] };
  };
  const h = harness({ host });
  await h.create(); await h.start();
  await turn(h, 'working', NOW + 1);
  // Act
  await h.runtime.watchTick(); await h.runtime.drain();
  // Assert
  const reads = h.calls.filter((call) => call.name === 'agent.listSessions');
  assert.deepEqual(reads.map((call) => call.input), [{ workspaceId: 'w1', limit: 200 }]);
  const summary = () => h.runtime.getState({ view: 'summary' }).runs[0].tokenUsage;
  assert.equal(summary().total, 120_000, 'only the job\'s own session counts');
  assert.equal(summary().stages.build.work, 120_000);
  assert.equal(savedState(h.store).runs[0].usage.sessions[0].latest, 120_000, 'persisted');

  failRead = true;
  await h.runtime.watchTick(); await h.runtime.drain();
  assert.equal(summary().total, 120_000, 'a failed read keeps the stored total');
  assert.equal(summary().scope, 'partial');
  assert.equal(h.getRun().jobs[0].state, 'running', 'a usage failure never touches the job');

  const restarted = harness({ store: h.store, host: async (name, input) => { if (name === 'agent.listSessions') { total = 150_000; failRead = false; } return host(name, input); } });
  await restarted.runtime.initialize(); await restarted.runtime.drain();
  assert.equal(restarted.runtime.getState({ view: 'summary' }).runs[0].tokenUsage.total, 120_000, 'restored from storage');
  await restarted.runtime.watchTick(); await restarted.runtime.drain();
  assert.equal(restarted.runtime.getState({ view: 'summary' }).runs[0].tokenUsage.total, 150_000, 'cumulative, not 120K + 150K');
  h.runtime.dispose(); restarted.runtime.dispose();
});
