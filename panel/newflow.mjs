/**
 * The new-flow form's two kinds of flow and the person-only product catalog approval.
 * The panel names a template (src/engine.mjs); it never sends its own stage list.
 */
import { e, options } from './kit.mjs';

// Mirrors src/engine.mjs DEFAULT_GRAPH and IMPROVE_GRAPH (the panel cannot import worker files);
// tests/panel.test.mjs keeps them equal. Used only to address per-stage assignments.
export const TEMPLATE_STAGES = Object.freeze({
  'new-app': ['research', 'brief', 'architecture', 'design', 'assets', 'build', 'test', 'policy', 'listing', 'internal', 'release'],
  improve: ['identity', 'diagnose', 'reproduce', 'measure', 'plan', 'design', 'assets', 'build', 'monetization', 'test', 'policy', 'listing', 'catalog', 'internal', 'release'],
});
export const KINDS = [
  ['bugfix', '오류 수정', '증상을 재현하고 고친 뒤 같은 증상으로 다시 확인합니다'],
  ['feature', '기능 추가', '새 기능과 영향을 받는 기존 기능을 함께 검증합니다'],
  ['design', '디자인·에셋 개선', '실제 화면의 전후를 비교합니다. 시안은 시안으로 표시합니다'],
  ['performance', '성능 최적화', '같은 조건에서 전후 수치를 잽니다'],
  ['maintenance', '유지보수', '의존성·구조 정리 등, 해당하는 검증을 실행합니다'],
  ['release', '출시 업데이트', '바뀐 부분을 다시 검증하고 출시 자료를 준비합니다. 제출은 직접 승인합니다'],
  ['listing', '스토어 설명·스크린샷 개선', '실제 앱 기준으로 설명과 스크린샷을 고칩니다. Play Console 반영은 직접 합니다'],
  ['policy', '정책·권한 점검', '권한·targetSdk·데이터 보안·결제 정책을 점검만 합니다'],
];
export const KIND_NAMES = Object.fromEntries(KINDS.map(([id, label]) => [id, label]));
const TYPES = [['new-app', '새 앱 만들기', '아이디어에서 출시까지'], ['improve', '기존 앱 개선하기', '출시한 앱을 종류별로 개선'],
  ['diagnose', '진단만 하기', '개선 후보만 찾고 바꾸지 않음'], ['resume', '이어하기', '끝나지 않은 흐름을 다시 시작']];

export function flowTypeSwitch(type) {
  return '<div class="flow-type" role="group" aria-label="흐름 종류">' + TYPES.map(([value, label, hint]) =>
    '<button type="button" class="flow-type-option" data-action="flow-type" data-type="' + value + '" aria-pressed="' + (type === value) + '"><strong>' + label + '</strong><span>' + hint + '</span></button>').join('') + '</div>';
}

/** Packages of the configured Play accounts, labelled with the app name when Play reported one. */
export function playAppOptions(play) {
  return (play?.accounts ?? []).flatMap((account) => (account.packages ?? []).map((packageName) => {
    const app = (account.apps ?? []).find((item) => item.packageName === packageName);
    return { value: account.id + '|' + packageName, label: [app?.name, packageName, account.name].filter(Boolean).join(' · ') };
  }));
}
function playField({ draft, play }) {
  const apps = playAppOptions(play);
  return '<label class="label" for="app-play">연결할 Play 앱 (선택)</label><select class="field" id="app-play" name="playApp"><option value="">연결하지 않음</option>' + options(apps, draft('playApp')) + '</select>' +
    '<p class="hint">' + (play ? (apps.length ? '연결하면 정체성 확인에 스토어 상태와 배포 버전이 들어갑니다.' : 'Play Store 탭에 등록된 패키지가 없습니다.') : 'Play 계정을 불러오고 있습니다.') + '</p>';
}

export function improveFields({ draft, play }) {
  const chosen = draft('kind', '');
  return '<fieldset class="improve-areas"><legend class="label">개선 종류</legend>' + KINDS.map(([id, label, hint]) =>
    '<label class="checkbox area-option"><input type="radio" name="kind" value="' + id + '" ' + (chosen === id ? 'checked' : '') + '><span><strong>' + label + '</strong><small>' + hint + '</small></span></label>').join('') + '</fieldset>' +
    '<fieldset class="improve-areas"><legend class="label">기능 추가 옵션</legend>' +
    '<label class="checkbox"><input type="checkbox" name="option_design" ' + (draft('option_design', false) ? 'checked' : '') + '>디자인·에셋도 함께</label>' +
    '<label class="checkbox"><input type="checkbox" name="option_payments" ' + (draft('option_payments', false) ? 'checked' : '') + '>결제 추가(상품 등록은 직접)</label></fieldset>' + playField({ draft, play });
}
export const diagnoseFields = ({ draft, play }) => '<p class="hint">정체성 확인 뒤 근거 있는 개선 후보 3~5개를 찾습니다. 아무것도 바꾸지 않으며, 원하는 후보를 골라 개선 흐름을 시작합니다.</p>' + playField({ draft, play });

/** Unfinished runs to resume; picking one never creates a run. */
export function resumeList(runs) {
  const open = (runs ?? []).filter((run) => !['completed', 'cancelled'].includes(run.status));
  if (!open.length) return '<p class="hint">이어갈 흐름이 없습니다.</p>';
  return '<ul class="resume-list">' + open.map((run) => '<li><button type="button" class="button small" data-action="resume-existing" data-run="' + e(run.id) + '">' +
    e(String(run.goal ?? '').split('\n')[0].slice(0, 80)) + ' · ' + e(run.status) + '</button></li>').join('') + '</ul>';
}

/** runs.create input from the form's values; throws a person-readable Error when incomplete. */
export function newRunPayload(values) {
  const template = ['improve', 'diagnose'].includes(values.flowType) ? values.flowType : 'new-app';
  const stages = TEMPLATE_STAGES[template === 'new-app' ? 'new-app' : 'improve'];
  const assignments = Object.fromEntries(stages.map((id) => [id, { agent: values.agent, reviewer: values.reviewer }]));
  const data = { template, projectId: values.projectId, assignments,
    maxConcurrency: Number(values.maxConcurrency), maxAttempts: Number(values.maxAttempts), maxRepairLoops: Number(values.maxRepairLoops) };
  if (template !== 'diagnose' || values.goal?.trim()) data.goal = values.goal;
  if (values.baseBranch?.trim()) data.baseBranch = values.baseBranch.trim();
  if (values.parentRunId) data.parentRunId = values.parentRunId;
  if (values.requestId) data.requestId = values.requestId; // one per opened form: a resubmit returns the run it made
  if (template === 'improve') {
    if (!KIND_NAMES[values.kind]) throw new Error('개선 종류를 고르세요.');
    data.kind = values.kind;
    data.options = { design: values.kind === 'feature' && Boolean(values.option_design), payments: values.kind === 'feature' && Boolean(values.option_payments) };
  }
  if (template !== 'new-app' && values.playApp) {
    const [accountId, packageName] = String(values.playApp).split('|');
    data.playLink = { accountId, packageName };
  }
  return data;
}

/** A passed diagnosis's candidates, each startable as its own improvement run. */
export function candidateList(item) {
  const node = item.nodes.find((entry) => entry.id === 'diagnose');
  const candidates = node?.status === 'passed' ? node.report?.candidates ?? [] : [];
  if (!candidates.length) return '';
  return '<section class="card candidates"><h3>개선 후보 ' + candidates.length + '개</h3><ol>' + candidates.map((c, index) =>
    '<li><strong>' + e(c.title) + '</strong> <span class="badge">' + e(KIND_NAMES[c.kind] ?? c.kind) + '</span>' +
    '<dl><dt>문제</dt><dd>' + e(c.problem) + '</dd><dt>근거</dt><dd>' + e(c.evidence) + '</dd><dt>사용자 영향</dt><dd>' + e(c.impact) + '</dd><dt>변경 범위</dt><dd>' + e(c.scope) + '</dd><dt>검증 방법</dt><dd>' + e(c.verify) + '</dd></dl>' +
    '<button type="button" class="button small primary" data-action="pick-candidate" data-run="' + e(item.id) + '" data-index="' + index + '">이 개선 시작</button></li>').join('') + '</ol></section>';
}

const TYPE_LABELS = { inapp: '일회성', subs: '구독' };
/** The products to confirm: the passed monetization report's list, else the plan's (as src/catalog.mjs). */
export function proposedProducts(item) {
  const from = (id) => { const report = item.nodes.find((node) => node.id === id)?.report; return report?.outcome === 'passed' && Array.isArray(report.products) ? report.products : null; };
  return from('monetization') ?? from('plan') ?? [];
}

export function catalogApprovalForm(item, node, { draft }) {
  const products = proposedProducts(item);
  return '<div class="divider"></div><form id="catalog-approval" data-run="' + e(item.id) + '" data-node="' + e(node.id) + '">' +
    '<div class="callout warning"><strong>Play Console에서 직접 하세요.</strong> 플러그인은 상품을 만들거나 바꾸지 않습니다. 판매자 계정(결제 프로필)을 확인하고 아래 상품을 만들어 활성화한 뒤, 만든 상품을 체크해 승인하세요.</div>' +
    (products.length ? '<ul class="product-list">' + products.map((product) => '<li><label class="checkbox"><input type="checkbox" name="confirm_' + e(product.productId) + '" ' + (draft('confirm_' + product.productId, false) ? 'checked' : '') + '>' +
      '<span class="mono">' + e(product.productId) + '</span> · ' + e(TYPE_LABELS[product.type] ?? product.type) + ' · ' + e(product.price) + (product.basePlanId ? ' · 기본 요금제 ' + e(product.basePlanId) : '') + (product.title ? ' · ' + e(product.title) : '') + '</label></li>').join('') + '</ul>'
      : '<p class="hint">결제 연동 보고서에 상품 제안이 없습니다. 보고서를 확인하세요.</p>') +
    '<label class="label" for="catalog-note">무엇을 등록했는지</label><textarea class="field" id="catalog-note" name="note" required maxlength="2000" placeholder="예: Play Console에 premium_unlock(₩3,900)을 만들고 활성화했습니다.">' + e(draft('note')) + '</textarea>' +
    '<div class="actions"><button class="button primary" type="submit">등록 확인 후 계속</button></div></form>';
}

/** runs.approve input for the catalog form. */
export function catalogApprovalInput(form, values) {
  const confirmed = Object.keys(values).filter((name) => name.startsWith('confirm_') && values[name]).map((name) => name.slice('confirm_'.length));
  return { runId: form.dataset.run, nodeId: form.dataset.node, note: values.note, productCatalog: { confirmed } };
}
