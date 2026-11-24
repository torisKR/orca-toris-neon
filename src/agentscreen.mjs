/**
 * Screens an agent CLI can show that no typed prompt answers: Codex's "Hooks need review" modal
 * (a hook in the user's Codex hooks.json is new or changed; seen with Codex 0.172.0), an account
 * usage limit, or a missing login. Retrying the same agent or typing more cannot help, and typing
 * into the hook review page toggles hook trust, so the stage stops with the exact action needed.
 */
const TAIL_LINES = 60;
const STATUS_LINES = 12; // account notices are the CLI's last lines; earlier lines may be the agent's own text
// Only the modal's whole layout counts, never its words alone: the typed prompt and the agent's output
// can mention them. Matching closes the terminal, so a false match would cost a healthy agent.
const SCREENS = [
  { kind: 'hook-review', tail: TAIL_LINES, pattern: /hooks? (?:is new or changed|needs? review before)|hooks need review/i,
    layout: /^\W*(?:review hooks|trust all and continue|space\/enter toggle)/im,
    message: (agent) => agent + '가 시작 화면의 "Hooks need review"(새로 추가되거나 바뀐 hook 검토)에서 멈춰 작업 지시를 실행하지 않았습니다. ' +
      agent + ' 설정(hooks.json)에 생긴 변경이라 Neon 밖의 조건입니다. 해결: 터미널에서 ' + agent + '를 한 번 직접 실행해 "Review hooks"(또는 /hooks)에서 바뀐 hook을 확인하고 신뢰하거나 지우세요. ' +
      'Neon은 hook 신뢰를 대신 바꾸지 않으며, 이 단계는 다른 에이전트로 진행할 수 있습니다.' },
  { kind: 'usage-limit', tail: STATUS_LINES, pattern: /you've hit your usage limit|claude usage limit reached|limit reached\s*[·∙•|]\s*resets/i,
    message: (agent) => agent + ' 계정의 사용 한도에 걸려 작업을 시작하지 못했습니다(계정 조건, Neon 밖). 한도가 풀린 뒤 다시 시도하거나 다른 에이전트로 진행하세요.' },
  { kind: 'login', tail: STATUS_LINES, pattern: /please run \/login|run `?codex login/i,
    message: (agent) => agent + '에 로그인되어 있지 않아 작업을 시작하지 못했습니다(계정 조건, Neon 밖). 터미널에서 ' + agent + '에 로그인한 뒤 다시 시도하세요.' },
];

/** { kind, message } for the newest lines of an agent terminal, or null. */
export function screenBlocker({ agent, lines }) {
  const all = Array.isArray(lines) ? lines.map(String) : [];
  const screen = SCREENS.find((item) => {
    const text = all.slice(-item.tail).join('\n');
    return item.pattern.test(text) && (!item.layout || item.layout.test(text));
  });
  return screen ? { kind: screen.kind, message: screen.message(agent) } : null;
}

/** Reads the job's terminal; an unreadable one is logged and leaves the decision to the existing checks. */
export async function readBlocker(call, { terminalId, agent }, log = () => {}) {
  if (!terminalId) return null;
  let lines;
  try { lines = (await call('terminal.read', { terminalId, maxLines: TAIL_LINES }))?.lines; }
  catch (error) {
    log('Toris Neon: 에이전트 화면을 읽지 못했습니다 (' + terminalId + '): ' + String(error?.message ?? error));
    return null;
  }
  return screenBlocker({ agent, lines });
}
