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

// Claude Code start-up dialogs that wait for a person (plain-text form, box drawing kept).
// The Code Mode notice appears when the person's Claude settings set CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1.
const CODE_MODE_NOTICE = ['╭────────────────────────────────────────────────────────────╮', '│ Code Mode (experimental)                                   │', '│                                                            │',
  '│ In Code Mode, Claude works by writing and running JavaScript that calls its tools, instead of calling tools one at a time. │',
  '│                                                            │', '│ ❯ 1. Continue                                              │', '╰────────────────────────────────────────────────────────────╯', '  Enter to confirm · Esc to exit'];
const FOLDER_TRUST = ['╭──────────────────────────────────────────────╮', '│ Do you trust the files in this folder?       │', '│                                              │', '│ /example/worktree                            │',
  '│ Claude Code may read files in this folder. Reading untrusted files may lead Claude Code to behave in unexpected ways. │',
  '│ ❯ 1. Yes, proceed                            │', '│   2. No, exit                                │', '╰──────────────────────────────────────────────╯', '   Enter to confirm · Esc to exit'];
const FOLDER_TRUST_NEW = [' Quick safety check: Is this a project you created or one you trust?', ' /example/worktree', ' ❯ 1. Yes, I trust this folder', '   2. No, exit', ' Enter to confirm · Esc to cancel'];

test('the Claude Code Mode notice is a start dialog that names the setting and the action', () => {
  // Arrange / Act
  const blocker = screenBlocker({ agent: 'claude', lines: CODE_MODE_NOTICE });
  // Assert
  assert.equal(blocker.kind, 'start-dialog');
  assert.equal(blocker.dialog, 'code-mode');
  assert.match(blocker.message, /Code Mode \(experimental\)/);
  assert.match(blocker.message, /Claude 설정의 CLAUDE_CODE_EXPERIMENTAL_CODE_MODE를 끄거나, Claude Code를 직접 열어 안내를 확인하세요/);
  assert.match(blocker.message, /Neon 밖/);
});

test('Claude Code\'s folder trust prompt, old and new wording, is a start dialog', () => {
  for (const lines of [FOLDER_TRUST, FOLDER_TRUST_NEW]) {
    const blocker = screenBlocker({ agent: 'claude', lines });
    assert.equal(blocker?.kind, 'start-dialog');
    assert.equal(blocker.dialog, 'folder-trust');
    assert.match(blocker.message, /폴더 신뢰/);
  }
});

test('near-miss text about the same dialogs is not a start dialog', () => {
  // The sentence quoted inside a task or an answer, without the dialog's title line.
  assert.equal(screenBlocker({ agent: 'claude', lines: ['› Detect the notice whose text starts "In Code Mode, Claude works by writing and running JavaScript that calls its tools"', '• Working'] }), null);
  // The title mentioned inside a sentence, not as its own line.
  assert.equal(screenBlocker({ agent: 'claude', lines: ['The screen was a notice titled "Code Mode (experimental)" shown because of a setting.', 'In Code Mode, Claude works by writing and running JavaScript that calls its tools.'] }), null);
  // A trust question in the agent's output with no choice of exiting.
  assert.equal(screenBlocker({ agent: 'claude', lines: ['Do you trust the files in this folder? is the prompt we detect.', '1. Yes, proceed'] }), null);
  // The trust dialog's options alone, without its question.
  assert.equal(screenBlocker({ agent: 'claude', lines: ['❯ 1. Yes, proceed', '  2. No, exit'] }), null);
});
