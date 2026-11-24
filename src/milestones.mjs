/**
 * What a run actually finished, for notifications and remote status: 구현 (every source-writing
 * stage except the Play submission stages), 검증 (the test stage), 제출 (an internal/release stage
 * that passed with an approved Play target). A stage the graph does not have is left out, never
 * called finished. 제출 is the approved submission only; publication is read from Play elsewhere.
 */
const SUBMIT = new Set(['internal', 'release']);
const passed = (node) => node.status === 'passed';

function implementation(nodes) {
  const writes = nodes.filter((node) => node.write && !SUBMIT.has(node.id));
  if (!writes.length) return null;
  const done = writes.filter(passed).length;
  return { id: 'implement', label: '구현', state: done === writes.length ? 'done' : done ? 'partial' : 'not_done', detail: done + '/' + writes.length + ' 단계' };
}

function verification(nodes) {
  const check = nodes.find((node) => node.id === 'test');
  return check ? { id: 'verify', label: '검증', state: passed(check) ? 'done' : 'not_done', detail: null } : null;
}

function submission(nodes) {
  const stages = nodes.filter((node) => SUBMIT.has(node.id));
  if (!stages.length) return null;
  if (stages.every((node) => node.status === 'skipped')) return { id: 'submit', label: '제출', state: 'skipped', detail: null }; // 여기까지만 (src/scope.mjs)
  const tracks = stages.filter((node) => passed(node) && node.approval?.submission?.track).map((node) => node.approval.submission.track);
  // 'approved': the person approved this Play target and the stage passed; an upload is read from Play elsewhere.
  return { id: 'submit', label: '제출', state: tracks.length ? 'approved' : 'not_done', detail: tracks.length ? tracks.join(', ') : null };
}

function diagnosis(nodes) {
  const report = nodes.find((node) => node.id === 'diagnose');
  return report ? { id: 'diagnose', label: '진단', state: passed(report) ? 'done' : 'not_done', detail: null } : null;
}

/** [{ id, label, state: 'done' | 'partial' | 'not_done' | 'approved' | 'skipped' (제출 only), detail }] for the stages this run has. */
export function milestones(run) {
  const nodes = run?.nodes ?? [];
  return [implementation(nodes), verification(nodes), submission(nodes), diagnosis(nodes)].filter(Boolean);
}

const WORDS = {
  implement: { done: () => '구현 완료', partial: (item) => '구현 진행 중(' + item.detail + ')', not_done: () => '구현 안 됨' },
  verify: { done: () => '검증 완료', not_done: () => '검증 안 됨' },
  submit: { approved: (item) => '제출 승인 완료 (' + item.detail + ') — Play 게시 여부는 Play Store 탭의 관측값으로 확인', not_done: () => '제출 안 함(사람이 계정과 대상을 지정해 승인해야 함)', skipped: () => '제출 단계 건너뜀(출시 업데이트 실행으로 이어서 할 수 있음)' },
  diagnose: { done: () => '진단 완료', not_done: () => '진단 안 됨' }
};

/** One line such as "구현 완료 · 검증 완료 · 제출 안 함(…)". */
export function milestoneText(run) {
  const items = milestones(run);
  return items.length ? items.map((item) => WORDS[item.id][item.state](item)).join(' · ') : '완료로 표시할 단계가 없습니다';
}
