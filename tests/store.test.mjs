import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ORCA_LIMITS, LEGACY_KEY, INDEX_KEY, runKey, archiveKey, BUDGETS, compactRun, fitRun, fileBytes,
  archiveRun, retainArchives, createRunStore, createPersistence, readStoredState,
} from '../src/store.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/runtime-v1-real.json', import.meta.url), 'utf8'));
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const LIVE = ['9d616373-5717-4ced-875b-4f26e81ba890', '0319b50a-54b5-41ac-a72e-4095e3d7fec3'];

/** Orca 1.4.268's plugin store (app.asar tP): same limits, same refusals, same file rewrite. */
export function orcaStorage(initial = {}, { failSet = () => false, corruptGet = () => false } = {}) {
  const data = new Map(Object.entries(structuredClone(initial)));
  const log = { sets: [], deletes: [] };
  const fileSize = () => Buffer.byteLength(JSON.stringify(Object.fromEntries(data), null, 2), 'utf8');
  return {
    data, log, fileSize,
    async get(key) {
      const value = data.has(key) ? structuredClone(data.get(key)) : null;
      return corruptGet(key) && value ? { ...value, tampered: true } : value;
    },
    async set(key, value) {
      if (failSet(key, value)) throw Object.assign(new Error('Orca could not complete this action'), { code: 'action_failed' });
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text, 'utf8') > ORCA_LIMITS.valueBytes) throw Object.assign(new Error('value exceeds 262144 bytes'), { code: 'action_failed' });
      if (!data.has(key) && data.size >= ORCA_LIMITS.keys) throw new Error('storage exceeds the 1024-key limit');
      const previous = data.get(key);
      data.set(key, JSON.parse(text));
      if (fileSize() > ORCA_LIMITS.fileBytes) { previous === undefined ? data.delete(key) : data.set(key, previous); throw new Error('storage exceeds 5242880 bytes'); }
      log.sets.push(key);
    },
    async delete(key) { data.delete(key); log.deletes.push(key); },
    async keys() { return [...data.keys()]; },
  };
}

const big = (n) => '가'.repeat(n);
/** An 11-stage run at the edge of every input limit, after many attempts and a long history. */
function worstRun(id = 'worst') {
  const evidence = Array.from({ length: 64 }, (_, i) => i % 2
    ? { kind: 'note', text: big(12_000) }
    : { kind: 'command', command: big(4000), exitCode: 0, output: big(3000) });
  const report = (phase, nonce) => ({ runId: id, nodeId: 'build', nonce, phase, outcome: 'passed', summary: big(12_000), next: big(4000), evidence, followUps: Array(12).fill(big(1000)) });
  const shortlist = { phase: 'work', agents: Array.from({ length: 4 }, (_, i) => ({ name: 'ecc:a' + i, why: big(400), description: big(800) })), skills: Array.from({ length: 5 }, (_, i) => ({ name: 's' + i, why: big(400) })) };
  const ids = ['research', 'brief', 'architecture', 'design', 'assets', 'build', 'test', 'policy', 'listing', 'internal', 'release'];
  const jobs = [];
  const nodes = ids.map((nodeId, index) => {
    const history = Array.from({ length: 30 }, (_, i) => report(i % 2 ? 'review' : 'work', nodeId + '-h' + i));
    for (let i = 0; i < 8; i++) jobs.push({ runId: id, nodeId, nonce: nodeId + '-j' + i, phase: 'work', attempt: i, agent: 'codex', state: 'complete',
      terminalId: 'term_' + i, receiptDirectory: '/Users/user/.toris-neon/runs/' + id + '/' + nodeId + '/' + i, receiptPath: '/Users/user/.toris-neon/runs/' + id + '/' + nodeId + '/' + i + '/result.json',
      ecc: shortlist, visual: { stage: nodeId, skills: shortlist.skills }, promptRecovery: { state: 'sent', terminalId: 'term_' + i }, reportFix: { reason: big(900) } });
    const active = index < 2 ? { phase: 'work', nonce: nodeId + '-live', attempt: 9 } : null;
    if (active) jobs.push({ runId: id, nodeId, nonce: active.nonce, phase: 'work', attempt: 9, agent: 'claude', state: 'running', terminalId: 'term_live', ecc: shortlist, visual: shortlist });
    return { id: nodeId, title: big(20), deps: [], status: active ? 'running' : 'passed', attempts: 9, reviewAttempts: 9, active,
      history, report: report('work', nodeId + '-r'), review: report('review', nodeId + '-v'), feedback: report('review', nodeId + '-f'), lastFailure: { summary: big(2000) },
      failureReason: big(12_000), runtimeMessage: big(4000), eccShortlist: shortlist, visualShortlist: shortlist,
      pendingReceipt: null };
  });
  return { id, goal: big(6000), status: 'running', autonomous: true, nodes, jobs,
    acceptedReports: Array.from({ length: 200 }, (_, i) => ({ nonce: 'n' + i, nodeId: 'build', phase: 'work' })),
    events: Array.from({ length: 2000 }, (_, i) => ({ id: id + ':' + i, at: '2026-11-22T00:00:00.000Z', type: 'task.reported', summary: big(12_000), next: big(4000), nodeId: 'build' })) };
}

test('the store uses the limits Orca 1.4.268 enforces', () => {
  assert.deepEqual({ ...ORCA_LIMITS }, { valueBytes: 262_144, keys: 1024, fileBytes: 5_242_880 });
  assert.ok(BUDGETS.run < ORCA_LIMITS.valueBytes);
  assert.ok(BUDGETS.total + 1024 * 1024 <= ORCA_LIMITS.fileBytes, 'room is left for the play and today keys');
});

test('file bytes count the pretty-printed copy Orca writes, not the compact value', () => {
  const value = { a: [1, 2], b: { c: 'x' } };
  assert.ok(fileBytes('k', value) > bytes(value));
  assert.equal(fileBytes('k', value), Buffer.byteLength(JSON.stringify({ k: value }, null, 2)) - 2, 'its line in the file, comma included, minus the braces');
});

test('compaction keeps every identity the engine and recovery need', () => {
  const run = FIXTURE.runs.find((item) => item.id === LIVE[0]);
  const doc = compactRun(run, 0);
  assert.equal(doc.goal, run.goal, 'the goal is kept once, whole');
  assert.deepEqual(doc.acceptedReports, run.acceptedReports);
  assert.deepEqual(doc.nodes.map((node) => [node.id, node.status, node.attempts, node.reviewAttempts, node.active?.nonce ?? null]),
    run.nodes.map((node) => [node.id, node.status, node.attempts, node.reviewAttempts, node.active?.nonce ?? null]));
  assert.deepEqual(doc.jobs.map((job) => [job.nonce, job.nodeId, job.phase, job.attempt, job.state, job.terminalId, job.receiptPath]),
    run.jobs.map((job) => [job.nonce, job.nodeId, job.phase, job.attempt, job.state, job.terminalId, job.receiptPath]));
  const live = doc.jobs.find((job) => job.state === 'running');
  assert.deepEqual(live, run.jobs.find((job) => job.state === 'running'), 'the running job is stored whole (its prompt may still be typed)');
  const finished = doc.jobs.find((job) => job.state === 'complete');
  assert.equal(finished.ecc, undefined, 'finished jobs drop their copy of the catalog shortlist');
  assert.equal(finished.visual, undefined);
  for (const node of doc.nodes) {
    for (const entry of node.history) assert.equal(entry.evidence, undefined, 'full reports stay on disk in the receipt folders');
    assert.equal(node.pendingReceipt?.ecc, undefined);
  }
  assert.equal(doc.nodes.find((node) => node.id === 'research').history.at(-1).outcome, run.nodes.find((node) => node.id === 'research').history.at(-1).outcome);
  assert.ok(bytes(doc) < bytes(run) * 0.8, 'the real run shrinks: ' + bytes(run) + ' → ' + bytes(doc));
});

test('a run at every input limit still fits one value, and the bound is reported', () => {
  const run = worstRun();
  assert.ok(bytes(run) > 10 * ORCA_LIMITS.valueBytes, 'the raw worst case is far over the limit');
  const fitted = fitRun(runKey(run.id), run, BUDGETS.run);
  assert.equal(fitted.level, 2);
  assert.ok(bytes(fitted.doc) < ORCA_LIMITS.valueBytes - 16 * 1024, 'worst case compact bytes ' + bytes(fitted.doc));
  assert.ok(fitted.bytes <= BUDGETS.run, 'worst case file bytes ' + fitted.bytes);
  assert.equal(fitted.doc.nodes.filter((node) => node.active).length, 2, 'live stages survive the deepest level');
  assert.equal(fitted.doc.jobs.filter((job) => job.state === 'running').length, 2);
  assert.ok(fitted.doc.eventsOmitted > 1900);
});

test('archived runs are trimmed and retention bounds their bytes, oldest first', () => {
  const archived = Array.from({ length: 80 }, (_, i) => archiveRun(worstRun('a' + i), '2026-11-' + String(1 + (i % 28)).padStart(2, '0') + 'T00:00:' + String(i % 60).padStart(2, '0') + '.000Z'));
  for (const run of archived) assert.ok(fileBytes(archiveKey(run.id), run) <= BUDGETS.archive, 'one archive ' + fileBytes(archiveKey(run.id), run));
  const { kept, dropped } = retainArchives(archived);
  const total = kept.reduce((sum, run) => sum + fileBytes(archiveKey(run.id), run), 0);
  assert.ok(total <= BUDGETS.archives, 'archives total ' + total);
  assert.ok(dropped.length > 0);
  const newestDropped = Math.max(...dropped.map((run) => Date.parse(run.archivedAt)));
  assert.ok(kept.every((run) => Date.parse(run.archivedAt) >= newestDropped), 'the oldest go first');
});

test('migration of the real-shaped state writes one key per run, verifies it, then drops the old value', async () => {
  const storage = orcaStorage({ [LEGACY_KEY]: FIXTURE, 'toris-neon.play.accounts.v1': { version: 1, accounts: [] } });
  const store = createRunStore({ storage });
  const { state, migration } = await store.load();
  assert.equal(migration.ok, true, migration.error);
  assert.equal(storage.data.has(LEGACY_KEY), false, 'the old value is removed only after verification');
  assert.equal(storage.data.get('toris-neon.play.accounts.v1').version, 1, 'other keys are untouched');
  assert.deepEqual(storage.data.get(INDEX_KEY).runs, FIXTURE.runs.map((run) => run.id));
  for (const key of storage.data.keys()) assert.ok(bytes(storage.data.get(key)) < BUDGETS.run, key + ' ' + bytes(storage.data.get(key)));
  assert.equal(state.revision, FIXTURE.revision);
  for (const id of LIVE) {
    const before = FIXTURE.runs.find((run) => run.id === id);
    const after = state.runs.find((run) => run.id === id);
    assert.equal(after.status, before.status);
    assert.equal(after.autonomous, true);
    assert.deepEqual(after.acceptedReports, before.acceptedReports);
    assert.deepEqual(after.nodes.map((node) => [node.id, node.status, node.attempts, node.reviewAttempts, node.active?.nonce ?? null, node.receipt?.path ?? null]),
      before.nodes.map((node) => [node.id, node.status, node.attempts, node.reviewAttempts, node.active?.nonce ?? null, node.receipt?.path ?? null]));
    assert.deepEqual(after.jobs.map((job) => [job.nonce, job.terminalId, job.sessionId ?? null, job.receiptPath, job.state, job.agentState]),
      before.jobs.map((job) => [job.nonce, job.terminalId, job.sessionId ?? null, job.receiptPath, job.state, job.agentState]));
  }
  assert.deepEqual(state.archivedRuns.map((run) => run.id), FIXTURE.archivedRuns.map((run) => run.id));
  const reread = await readStoredState(storage);
  assert.deepEqual(reread.state.runs.map((run) => run.id), state.runs.map((run) => run.id));
  assert.equal(reread.problems.length, 0);
});

test('a migration that cannot write leaves the old state readable and unchanged', async () => {
  const storage = orcaStorage({ [LEGACY_KEY]: FIXTURE }, { failSet: (key) => key === runKey(LIVE[1]) });
  const { state, migration } = await createRunStore({ storage }).load();
  assert.equal(migration.ok, false);
  assert.match(migration.error, /Orca could not complete/);
  assert.deepEqual(storage.data.get(LEGACY_KEY), FIXTURE);
  assert.equal(storage.data.has(INDEX_KEY), false, 'without an index the next start migrates again');
  assert.deepEqual(state.runs.map((run) => run.id), FIXTURE.runs.map((run) => run.id), 'the worker still runs from the old state');
});

test('a migration whose read-back differs keeps the old value', async () => {
  const storage = orcaStorage({ [LEGACY_KEY]: FIXTURE }, { corruptGet: (key) => key === runKey(LIVE[0]) });
  const { migration } = await createRunStore({ storage }).load();
  assert.equal(migration.ok, false);
  assert.match(migration.error, /다시 읽은 값/);
  assert.deepEqual(storage.data.get(LEGACY_KEY), FIXTURE);
  assert.equal(storage.data.has(INDEX_KEY), false);
});

test('an invalid old value is refused without writing anything', async () => {
  const storage = orcaStorage({ [LEGACY_KEY]: { version: 7, runs: 'x' } });
  await assert.rejects(createRunStore({ storage }).load(), /형식이 지원되지 않습니다/);
  assert.equal(storage.log.sets.length, 0);
});

test('saving writes only the values that changed, the index only when runs come or go', async () => {
  const storage = orcaStorage();
  const store = createRunStore({ storage });
  const { state } = await store.load();
  state.runs.push(structuredClone(FIXTURE.runs[1]), structuredClone(FIXTURE.runs[2]));
  state.revision = 5;
  await store.save(state);
  assert.deepEqual(storage.log.sets, [runKey(FIXTURE.runs[1].id), runKey(FIXTURE.runs[2].id), INDEX_KEY]);
  storage.log.sets.length = 0;
  state.revision = 6;
  state.runs[1].events.push({ id: 'e', at: '2026-11-22T00:00:00.000Z', type: 'runtime', summary: '새 일' });
  await store.save(state);
  assert.deepEqual(storage.log.sets, [runKey(FIXTURE.runs[2].id)]);
  assert.equal((await readStoredState(storage)).state.revision, 6, 'the revision rides on the written run');
  storage.log.sets.length = 0;
  await store.save(state);
  assert.deepEqual(storage.log.sets, [], 'nothing changed, nothing written');
  const [gone] = state.runs.splice(0, 1);
  state.archivedRuns.push(archiveRun(gone, '2026-11-22T01:00:00.000Z'));
  await store.save(state);
  assert.deepEqual(storage.log.sets, [archiveKey(gone.id), INDEX_KEY]);
  assert.deepEqual(storage.log.deletes, [runKey(gone.id)], 'the run key goes after the index no longer names it');
});

test('a run that outgrows its budget is compacted before Orca would refuse it', async () => {
  const storage = orcaStorage();
  const store = createRunStore({ storage });
  const { state } = await store.load();
  state.runs.push(worstRun('heavy'));
  await store.save(state);
  assert.ok(bytes(storage.data.get(runKey('heavy'))) < ORCA_LIMITS.valueBytes);
  assert.ok(storage.fileSize() < BUDGETS.total);
});

test('a leftover old value next to a complete new layout is removed', async () => {
  const storage = orcaStorage();
  const store = createRunStore({ storage });
  const { state } = await store.load();
  state.runs.push(structuredClone(FIXTURE.runs[1]));
  await store.save(state);
  storage.data.set(LEGACY_KEY, FIXTURE);
  const loaded = await createRunStore({ storage }).load();
  assert.deepEqual(loaded.state.runs.map((run) => run.id), [FIXTURE.runs[1].id]);
  assert.equal(storage.data.has(LEGACY_KEY), false);
});

test('a missing run value is reported, not silently dropped, and the old value is kept', async () => {
  const storage = orcaStorage();
  const store = createRunStore({ storage });
  const { state } = await store.load();
  state.runs.push(structuredClone(FIXTURE.runs[1]));
  await store.save(state);
  storage.data.set(LEGACY_KEY, FIXTURE);
  storage.data.delete(runKey(FIXTURE.runs[1].id));
  const loaded = await createRunStore({ storage }).load();
  assert.match(loaded.problems.join(' '), /찾을 수 없습니다/);
  assert.equal(storage.data.has(LEGACY_KEY), true);
});

test('a failed save warns on the runs, notifies once, retries, and clears on recovery', async () => {
  let failing = true;
  const storage = orcaStorage({}, { failSet: () => failing });
  const notes = [];
  const logs = [];
  const timers = [];
  const persistence = createPersistence({
    storage, log: (line) => logs.push(line), notify: (title, body) => notes.push(title + ' ' + body),
    retry: () => timers.push('retry'), now: () => Date.parse('2026-11-22T06:00:00.000Z'),
    setTimer: (fn, ms) => { timers.push(ms); return { fn }; }, clearTimer: () => {},
  });
  const { state } = await persistence.load();
  state.runs.push({ id: 'r1', status: 'running', nodes: [], jobs: [], events: [], acceptedReports: [] });
  const first = await persistence.save(state);
  assert.equal(first.ok, false);
  assert.match(state.runs[0].storageWarning.message, /Orca could not complete/);
  assert.equal(state.runs[0].storageWarning.attempts, 1);
  const second = await persistence.save(state);
  assert.equal(second.ok, false);
  assert.equal(notes.length, 1, 'one notification per failure episode');
  assert.equal(persistence.failure().attempts, 2);
  assert.ok(timers.includes(5000), 'a retry is scheduled');
  failing = false;
  assert.equal((await persistence.save(state)).ok, true);
  assert.equal(state.runs[0].storageWarning, undefined);
  assert.equal(persistence.failure(), null);
  assert.equal(storage.data.get(runKey('r1')).run.storageWarning, undefined, 'the warning itself is never stored');
  assert.match(logs.join('\n'), /복구/);
});
