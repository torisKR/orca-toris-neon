import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestLedger, REQUESTS_KEY, MAX_PRUNED } from '../src/requests.mjs';

const AT = '2026-11-24T03:00:00.000Z';
const memory = (failSet = () => false) => {
  const map = new Map();
  return { map, get: async (key) => structuredClone(map.get(key) ?? null), set: async (key, value) => { if (failSet()) throw new Error('disk full'); map.set(key, structuredClone(value)); } };
};
const pruned = (index, extra = {}) => ({ id: 'run-' + index, requestId: 'req:remote.bot-' + index + '.0123456789abcdef', status: 'completed', projectId: 'p1', nodes: [], ...extra });

test('a pruned run\'s request key and run id are kept in their own small store and read back after a restart', async () => {
  // Arrange
  const storage = memory();
  const ledger = createRequestLedger(storage);
  await ledger.load();
  // Act
  await ledger.remember([pruned(1), { id: 'no-request', status: 'completed', nodes: [] }], AT);
  const restarted = createRequestLedger(storage);
  await restarted.load();
  // Assert
  assert.deepEqual(restarted.list(), [{ requestId: 'req:remote.bot-1.0123456789abcdef', id: 'run-1', status: 'completed', projectId: 'p1', prunedAt: AT, pruned: true }]);
  assert.equal(storage.map.get(REQUESTS_KEY).entries.length, 1, 'only runs with a request key are kept');
});

test('the store is bounded: the oldest pruned keys go first', async () => {
  const ledger = createRequestLedger(memory());
  await ledger.load();
  await ledger.remember(Array.from({ length: MAX_PRUNED + 5 }, (_, index) => pruned(index)), AT);
  const ids = ledger.list().map((entry) => entry.id);
  assert.equal(ids.length, MAX_PRUNED);
  assert.equal(ids[0], 'run-5');
});

test('after a failed load, remembering never overwrites the stored keys it could not read', async () => {
  // Arrange
  const storage = memory();
  storage.map.set(REQUESTS_KEY, { version: 1, entries: [{ requestId: 'req:old', id: 'run-old', status: 'completed', projectId: 'p1', prunedAt: AT, pruned: true }] });
  let locked = true;
  const flaky = { get: async (key) => { if (locked) throw new Error('locked'); return storage.get(key); }, set: storage.set };
  const ledger = createRequestLedger(flaky);
  await ledger.load();
  // Act
  await ledger.remember([pruned(1)], AT);
  locked = false;
  await ledger.remember([pruned(2)], AT);
  // Assert
  assert.deepEqual(storage.map.get(REQUESTS_KEY).entries.map((entry) => entry.id), ['run-old', 'run-1', 'run-2']);
});

test('a failed write keeps the keys in memory and says so in the log; an unreadable store starts empty without throwing', async () => {
  // Arrange
  const lines = [];
  const ledger = createRequestLedger(memory(() => true), (line) => lines.push(line));
  const broken = createRequestLedger({ get: async () => { throw new Error('locked'); }, set: async () => {} }, (line) => lines.push(line));
  // Act
  await ledger.remember([pruned(1)], AT);
  await broken.load();
  // Assert
  assert.equal(ledger.list().length, 1);
  assert.equal(broken.list().length, 0);
  assert.match(lines.join('\n'), /disk full/);
  assert.match(lines.join('\n'), /locked/);
});
