/**
 * What a failed terminal.sendText means for the prompt, read from Orca 1.4.269 (app.asar). The plugin
 * handler runs: resolveActiveWorktreeContext → listWorktreeTerminals (builds every terminal's summary)
 * → assertActive → sendTerminal → sendTerminalAfterPluginHooks → writeTerminalAction (the write).
 * Errors listed here are thrown before writeTerminalAction, so nothing reached the terminal and the
 * same prompt may be typed again. Anything else (timeouts, cancellation, generic or unknown errors)
 * may follow a write and stays 'uncertain': never resent automatically.
 */
export const SEND_ERRORS = Object.freeze([
  { id: 'terminal_surface_ownership_unavailable', kind: 'message', retry: true,
    where: 'buildPtyTerminalSummary, while listWorktreeTerminals lists the active worktree: a PTY not yet held by a pane while its registration or a spawn is pending (just after a launch)' },
  { id: 'no active worktree is available for terminal input', kind: 'message', retry: true,
    where: 'terminal.sendText handler, resolveActiveWorktreeContext found no active worktree' },
  { id: 'terminal is outside the active worktree', kind: 'message', retry: true,
    where: 'terminal.sendText handler, the terminal is not in the active worktree list (focus moved)' },
  { id: 'terminal_not_writable', kind: 'message', retry: true,
    where: 'sendTerminalAfterPluginHooks, the PTY is not connected or proven absent, before writeTerminalAction' },
  { id: 'invalid_terminal_send', kind: 'message', retry: false,
    where: 'sendTerminalAfterPluginHooks, the text could not be encoded for sending, before writeTerminalAction' },
  { id: 'rate_limited', kind: 'code', retry: true, where: 'plugin bridge, too many calls in flight; the call never reached the handler' },
  { id: 'capability_denied', kind: 'code', retry: false, where: 'host call check, the capability is not granted; the handler never ran' },
  { id: 'consent_required', kind: 'code', retry: false, where: 'host call check, consent is missing; the handler never ran' },
  { id: 'not_permitted', kind: 'code', retry: false, where: 'host call check, the call is not permitted; the handler never ran' },
  { id: 'unknown_method', kind: 'code', retry: false, where: 'host call check, the method does not exist in this Orca; the handler never ran' },
  { id: 'invalid_params', kind: 'code', retry: false, where: 'host call schema check, the parameters were refused; the handler never ran' },
]);
/** Waits before each retry of a send refused before writing; the terminal is focused again first. */
export const SEND_RETRY_DELAYS_MS = [2000, 5000];

/** { sent: false, retry, id } for a refusal before writing, or { sent: 'unknown' }. */
export function classifySendError(error) {
  const message = String(error?.message ?? '');
  const entry = SEND_ERRORS.find((item) => item.kind === 'code' ? error?.code === item.id : message.includes(item.id));
  return entry ? { sent: false, retry: entry.retry, id: entry.id } : { sent: 'unknown', retry: false, id: null };
}
