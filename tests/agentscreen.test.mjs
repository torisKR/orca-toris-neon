import test from 'node:test';
import assert from 'node:assert/strict';
import { screenBlocker, readBlocker } from '../src/agentscreen.mjs';

// What Codex 0.172.0 drew in the stuck terminal of the live run, in Orca's plain-text form.
const HOOK_MODAL = ['  >_ OpenAI Codex (v0.172.0)', '  1 hook is new or changed.', '  Hooks need review',
  '  Hooks can run outside the sandbox after you trust them.', '› Review hooks', '  Trust all and continue', '  Continue without trusting (hooks won\'t run)'];
const HOOK_PAGE = ['  >_ OpenAI Codex (v0.172.0)', '  permissions: YOLO mode', '  UserPromptSubmit hooks', '  1 hook needs review before it can run.',
  '› [x]  1  Reporting status to Orca', '  [!]  4  Unnamed hook · modified', '  space/enter toggle · esc back'];

test('the Codex hook-review modal is an external condition that names the exact action', () => {
  // Arrange / Act
  const blocker = screenBlocker({ agent: 'codex', lines: HOOK_MODAL });
  // Assert
  assert.equal(blocker.kind, 'hook-review');
  assert.match(blocker.message, /Hooks need review/);
  assert.match(blocker.message, /Review hooks/);
  assert.match(blocker.message, /\/hooks/);
  assert.match(blocker.message, /Neon 밖/);
});

test('the hook review page reached after typing into the modal is recognised too', () => {
  assert.equal(screenBlocker({ agent: 'codex', lines: HOOK_PAGE })?.kind, 'hook-review');
});

test('an account usage limit and a missing login are recognised as account conditions', () => {
  assert.equal(screenBlocker({ agent: 'codex', lines: ['■ You\'ve hit your usage limit. Try again at 9:40 PM.'] })?.kind, 'usage-limit');
  assert.equal(screenBlocker({ agent: 'claude', lines: ['Claude usage limit reached · resets 3pm'] })?.kind, 'usage-limit');
  assert.equal(screenBlocker({ agent: 'claude', lines: ['Invalid API key · Please run /login'] })?.kind, 'login');
});

test('ordinary agent output is not a blocker, even when it mentions the same words', () => {
  assert.equal(screenBlocker({ agent: 'claude', lines: ['• Edited lib/hooks.dart', 'Tests: 42 passed', '› '] }), null);
  assert.equal(screenBlocker({ agent: 'codex', lines: ['› Fix the case where Codex says "Hooks need review" and stops', '• Working'] }), null);
  assert.equal(screenBlocker({ agent: 'claude', lines: ['test: shows "not logged in" banner ... ok', 'Done. 12 tests passed.'] }), null);
  assert.equal(screenBlocker({ agent: 'claude', lines: ['The API returns 429 when the usage limit reached is exceeded.', 'Done.'] }), null);
  assert.equal(screenBlocker({ agent: 'codex', lines: [] }), null);
});

test('only the newest lines decide, so an old screen scrolled far away no longer blocks', () => {
  const lines = [...HOOK_MODAL, ...Array.from({ length: 80 }, (_, index) => 'work line ' + index)];
  assert.equal(screenBlocker({ agent: 'codex', lines }), null);
});

test('readBlocker reads the job terminal through terminal.read', async () => {
  // Arrange
  const calls = [];
  const call = async (name, input) => { calls.push({ name, input }); return { lines: HOOK_PAGE, truncated: false }; };
  // Act
  const blocker = await readBlocker(call, { terminalId: 't1', agent: 'codex' });
  // Assert
  assert.equal(blocker.kind, 'hook-review');
  assert.deepEqual(calls, [{ name: 'terminal.read', input: { terminalId: 't1', maxLines: 60 } }]);
});

test('a malformed terminal.read result is treated as an empty screen', async () => {
  assert.equal(await readBlocker(async () => ({ lines: 'Hooks need review' }), { terminalId: 't1', agent: 'codex' }), null);
});

test('an unreadable terminal is logged and treated as no blocker, so the existing checks decide', async () => {
  // Arrange
  const logged = [];
  const call = async () => { throw new Error('terminal gone'); };
  // Act
  const blocker = await readBlocker(call, { terminalId: 't1', agent: 'codex' }, (line) => logged.push(line));
  // Assert
  assert.equal(blocker, null);
  assert.match(logged[0], /terminal gone/);
  assert.equal(await readBlocker(call, { terminalId: null, agent: 'codex' }), null);
});
