/**
 * Plan 5.2: the one next action of each Today item.
 * A run: recover what Neon could not confirm (a stop, a workspace, a launch), show the outside
 * condition a stage waits for and its screen, resume a paused run (runs.resume checks the live
 * agents first), open a failed stage, or improve a finished result. A handoff note: re-verify when
 * its recorded verification is stale, show the recovery path of an uncertain start, else continue.
 * Every action reuses what exists (runs.resume, the stored start receipt, the new-run request id),
 * so pressing it again never makes a second run or agent.
 */
import { e, badge, button, title, goalTitle, localDate } from './kit.mjs';

const PLAY_SCREEN = new Set(['monetization', 'policy', 'listing', 'catalog', 'internal', 'release']);
const reportOf = (node) => (node.blockedPhase === 'review' ? node.review : node.report) ?? {};
const isExternal = (node) => node.status === 'blocked' && (reportOf(node).failureClass === 'external' || reportOf(node).outcome === 'blocked');

function recovery(run) {
  if (run.cancelUnsaved) return { text: '취소를 아직 저장하지 못했습니다. 새 단계는 배정하지 않고, 저장되면 Neon이 에이전트 터미널을 닫습니다.' };
  if (run.stopFailures?.length) return { text: 'Orca가 에이전트 터미널 ' + run.stopFailures.length + '개의 종료를 확인하지 못했습니다. 남은 터미널을 확인한 뒤 실행 카드에서 다시 정리하세요.' };
  if (run.workspaceCreation?.state === 'uncertain') return { text: '작업 공간 생성 결과가 불명확합니다. Orca에서 ' + (run.workspaceCreation.name ?? '예약된') + ' 작업 공간이 있는지 확인하고, 실행 카드에서 그 공간을 연결하세요.' };
  const node = (run.nodes ?? []).find((item) => item.launchUncertain);
  if (node) return { node, text: title(node) + ' 단계의 에이전트 시작 결과가 불명확합니다. 다시 보내면 작업이 중복될 수 있어 자동으로 다시 보내지 않습니다. 단계에서 이전 터미널을 확인하세요.' };
  return null;
}

/** A finished diagnosis: how many candidates it recorded, or plainly that it recorded none. */
function diagnosisNote(run) {
  if (run.template !== 'diagnose') return { text: '' };
  const candidates = (run.nodes ?? []).find((node) => node.id === 'diagnose')?.report?.candidates;
  const count = Array.isArray(candidates) ? candidates.length : 0;
  return count ? { text: '개선 후보 ' + count + '개 · 흐름을 열어 후보를 골라 시작하세요. ' }
    : { warn: true, text: '구조화된 개선 후보가 기록되지 않았습니다. 진단 보고서(verification.md)의 후보를 개선 목표에 붙여 넣어 시작하세요. ' };
}

/** { type: recover|external|resume|followup|stage|open, node?, text?, screen?, warn? } of a Today run. */
export function runAction(run) {
  const recover = recovery(run);
  if (recover) return { type: 'recover', node: recover.node ?? null, text: recover.text, screen: null };
  if (run.status === 'completed') {
    const note = diagnosisNote(run);
    return { type: 'followup', node: null, text: note.text + '이 결과를 기준으로 새 개선 작업을 시작할 수 있습니다. 이전 결과는 그대로 남습니다.', screen: null, ...(note.warn ? { warn: true } : {}) };
  }
  const nodes = run.nodes ?? [];
  const external = nodes.find(isExternal);
  if (external) return { type: 'external', node: external, screen: PLAY_SCREEN.has(external.id) ? 'play' : null,
    text: '외부 조건이 필요합니다 · ' + title(external) + ': ' + (external.failureReason || '필요한 계정·기기·입력을 단계에서 확인하세요.') };
  const approval = nodes.find((node) => node.status === 'awaiting-approval');
  if (approval) return { type: 'external', node: approval, screen: null,
    text: approval.humanApproval ? title(approval) + ': Play Console에서 상품을 직접 등록한 뒤 확인해 주세요.' : title(approval) + ': 사람의 승인이 필요합니다. 승인 범위를 확인해 주세요.' };
  if (run.status === 'paused') return { type: 'resume', node: null, text: '재개하면 Neon이 살아 있는 작업과 터미널 상태를 먼저 확인한 뒤 이어갑니다.', screen: null };
  const failed = nodes.find((node) => ['failed', 'blocked'].includes(node.status));
  if (failed) return { type: 'stage', node: failed, text: title(failed) + ': ' + (failed.failureReason || '단계에서 원인을 확인하세요.'), screen: null };
  return { type: 'open', node: null, text: '', screen: null };
}

/** The callout and buttons of a Today run card. */
export function runActions(run) {
  const action = runAction(run), name = goalTitle(run.goal);
  // Every card has the same buttons: the accessible name starts with the visible text and adds the run.
  const id = (label) => 'data-run="' + e(run.id) + '" aria-label="' + e(label + ' · ' + name) + '"';
  const stageButton = (label) => action.node ? button(label, 'open-stage', 'data-node="' + e(action.node.id) + '" ' + id(label)) : '';
  const buttons = {
    recover: button('상태 다시 확인', 'refresh-run', id('상태 다시 확인'), 'primary') + (stageButton('복구할 단계 열기') || button('실행 카드 열기', 'open-run', id('실행 카드 열기'))),
    external: stageButton('해당 단계 열기') + (action.screen === 'play' ? button('Play Store 화면', 'tab', 'data-tab="play"') : ''),
    resume: button('상태 확인 후 재개', 'resume-run', id('상태 확인 후 재개'), 'primary'),
    followup: button('이 결과로 개선 →', 'improve-result', id('이 결과로 개선'), 'primary'),
    stage: stageButton('단계 열기'),
    open: '',
  }[action.type];
  const tone = action.warn || ['recover', 'external', 'stage'].includes(action.type) ? 'callout warning' : 'hint';
  return (action.text ? '<p class="' + tone + '">' + e(action.text) + '</p>' : '') + '<div class="actions">' + buttons + button('흐름 열기 →', 'open-run', id('흐름 열기'), action.type === 'open' ? 'primary' : '') + '</div>';
}

/** A Today run card: where it stands and its one next action. */
export function todayRunCard(run) {
  const node = run.nodes?.find((n) => ['running', 'review', 'blocked', 'failed', 'awaiting-approval'].includes(n.status)) ?? run.nodes?.find((n) => !['passed', 'skipped'].includes(n.status));
  const done = run.nodes?.filter((n) => n.status === 'passed').length ?? 0, total = run.nodes?.filter((n) => n.status !== 'skipped').length ?? 0;
  return '<article class="card accent"><div class="card-head"><div class="grow"><div class="card-title goal-title" title="' + e(goalTitle(run.goal)) + '">' + e(goalTitle(run.goal)) + '</div>' +
    '<div class="card-subtitle">' + e(run.status === 'completed' ? '완료된 결과' : node ? '다음 지점 · ' + title(node) : '전체 흐름을 확인해 주세요') + '</div></div>' + badge(run.status) + '</div>' +
    '<div class="progress" aria-label="' + done + '/' + total + '단계 완료"><span style="width:' + (total ? done / total * 100 : 0) + '%"></span></div>' +
    '<div class="progress-label"><span>' + done + ' / ' + total + '단계 검토 완료</span><span>' + e(localDate(run.updatedAt)) + '</span></div>' + runActions(run) + '</article>';
}

/** { type: recover|reverify|continue, html } of a handoff note's action row; `agents` is the provider <option> list. */
export function noteAction(note, agents = '') {
  const ws = 'data-workspace="' + e(note.workspaceId) + '"';
  const named = (label) => ws + ' aria-label="' + e(label + ' · ' + note.projectName) + '"';
  const picker = '<select class="field note-agent" aria-label="' + e(note.projectName) + ' 이어하기 에이전트" data-note-agent="' + e(note.workspaceId) + '">' + agents + '</select>';
  const workspace = button('작업 공간', 'open-workspace', named('작업 공간'), 'small');
  if (['uncertain', 'launching'].includes(note.launch?.status)) return { type: 'recover', html:
    '<p class="callout warning">이전 ' + (note.launch.mode === 'reverify' ? '재검증' : '이어하기') + ' 시작 결과를 확인하지 못했습니다. 중복 실행을 막기 위해 다시 시작하지 않습니다. 작업 공간의 터미널을 확인하고, 이어서 할 일이 남았다면 새 인계 메모를 저장하세요.</p><div class="actions">' + workspace + '</div>' };
  if (note.verificationFreshness === 'stale') return { type: 'reverify', html:
    '<p class="hint">검증을 기록한 뒤 코드가 바뀌었습니다. 바뀐 범위에 해당하는 검증만 다시 실행합니다.</p><div class="actions">' + picker +
    button('바뀐 범위 재검증', 'reverify-note', named('바뀐 범위 재검증'), 'primary') + button('오늘 이어하기', 'resume-note', named('오늘 이어하기')) + workspace + '</div>' };
  return { type: 'continue', html: '<div class="actions">' + picker + button('오늘 이어하기 →', 'resume-note', named('오늘 이어하기'), 'primary') + workspace + '</div>' };
}
