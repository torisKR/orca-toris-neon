import test from 'node:test';
import assert from 'node:assert/strict';
import { sendingEvidence } from '../src/sending.mjs';

const AT = '2026-11-24T09:50:28.695Z';
const job = (extra = {}) => ({ promptRecovery: { state: 'sending', at: AT }, ...extra });

test('a turn already seen proves the prompt that was being sent arrived', () => {
  assert.ok(sendingEvidence({ job: job({ promptSeen: true }), agent: null, receipt: false }));
});

test('an agent working or blocked on its terminal proves the prompt arrived', () => {
  assert.ok(sendingEvidence({ job: job(), agent: { state: 'working' }, receipt: false }));
  assert.ok(sendingEvidence({ job: job(), agent: { state: 'blocked' }, receipt: false }));
});

test('a report in the receipt folder proves the prompt arrived', () => {
  assert.ok(sendingEvidence({ job: job(), agent: { state: 'done' }, receipt: true }));
});

test('an agent that became done after the send began has worked on it', () => {
  const after = Date.parse(AT) + 60_000;
  assert.ok(sendingEvidence({ job: job(), agent: { state: 'done', stateStartedAt: after }, receipt: false }));
});

test('an idle agent from before the send, a waiting agent or no agent stays unknown', () => {
  const before = Date.parse(AT) - 1000;
  assert.equal(sendingEvidence({ job: job(), agent: { state: 'done', stateStartedAt: before }, receipt: false }), null);
  assert.equal(sendingEvidence({ job: job(), agent: { state: 'done' }, receipt: false }), null);
  assert.equal(sendingEvidence({ job: job(), agent: { state: 'waiting', stateStartedAt: Date.parse(AT) + 5 }, receipt: false }), null);
  assert.equal(sendingEvidence({ job: job(), agent: undefined, receipt: false }), null);
});
