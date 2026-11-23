import test from 'node:test';
import assert from 'node:assert/strict';
import { SEND_ERRORS, classifySendError, SEND_RETRY_DELAYS_MS } from '../src/delivery.mjs';

const hostError = (message, code = 'action_failed') => Object.assign(new Error(message), { code });

// One test per entry of the table: what Orca 1.4.269 throws from terminal.sendText before writing.
for (const entry of SEND_ERRORS) {
  test('host error ' + entry.id + ' is classified as not sent' + (entry.retry ? ', retried' : ', not retried'), () => {
    const error = entry.kind === 'code' ? hostError('refused', entry.id) : hostError(entry.id);
    const verdict = classifySendError(error);
    assert.equal(verdict.sent, false, entry.where);
    assert.equal(verdict.retry, entry.retry);
    assert.equal(verdict.id, entry.id);
    assert.ok(entry.where.length > 10, 'every entry says where Orca throws it');
  });
}

test('the incident\'s exact error is not sent and retried', () => {
  const verdict = classifySendError(hostError('terminal_surface_ownership_unavailable'));
  assert.deepEqual([verdict.sent, verdict.retry], [false, true]);
});

test('anything that can happen after writing, or that the table does not know, stays uncertain', () => {
  for (const error of [hostError('response timeout', 'timeout'), hostError('cancelled', 'cancelled'), hostError('Orca could not complete this action'),
    new Error('socket hang up'), null, undefined]) {
    assert.equal(classifySendError(error).sent, 'unknown', String(error?.message));
  }
});

test('retries are few and short so the run queue is not held for long', () => {
  assert.ok(SEND_RETRY_DELAYS_MS.length >= 1 && SEND_RETRY_DELAYS_MS.length <= 3);
  assert.ok(SEND_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) <= 10_000);
});
