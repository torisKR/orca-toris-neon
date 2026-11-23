/**
 * The new-flow form's two kinds of flow and the person-only product catalog approval.
 * The panel names a template (src/engine.mjs); it never sends its own stage list.
 */
import { e, options } from './kit.mjs';

// Mirrors src/engine.mjs DEFAULT_GRAPH and IMPROVE_GRAPH (the panel cannot import worker files);
// tests/panel.test.mjs keeps them equal. Used only to address per-stage assignments.
export const TEMPLATE_STAGES = Object.freeze({
  'new-app': ['research', 'brief', 'architecture', 'design', 'assets', 'build', 'test', 'policy', 'listing', 'internal', 'release'],
  improve: ['audit', 'plan', 'design', 'assets', 'build', 'monetization', 'test', 'policy', 'listing', 'catalog', 'internal', 'release'],
});
export const AREAS = [
  ['design', '디자인 개선', '현재 화면에서 출발해 디자인과 에셋을 다듬습니다'],
  ['features', '기능 추가', '기존 동작을 테스트로 고정한 뒤 기능을 더합니다'],
  ['payments', '결제 추가', 'Play 결제와 페이월을 연동합니다. 상품 등록은 직접 합니다'],
];
const TYPES = [['new-app', '새 앱 만들기', '아이디어에서 출시까지'], ['improve', '기존 앱 디벨롭', '출시한 앱의 디자인·기능·결제 개선']];

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

export function improveFields({ draft, play }) {
  const apps = playAppOptions(play);
  return '<fieldset class="improve-areas"><legend class="label">개선 영역 (하나 이상)</legend>' + AREAS.map(([id, label, hint]) =>
    '<label class="checkbox area-option"><input type="checkbox" name="area_' + id + '" ' + (draft('area_' + id, false) ? 'checked' : '') + '><span><strong>' + label + '</strong><small>' + hint + '</small></span></label>').join('') + '</fieldset>' +
    '<label class="label" for="app-play">연결할 Play 앱 (선택)</label><select class="field" id="app-play" name="playApp"><option value="">연결하지 않음</option>' + options(apps, draft('playApp')) + '</select>' +
    '<p class="hint">' + (play ? (apps.length ? '연결하면 현황 진단에 스토어 상태와 배포 버전이 들어갑니다.' : 'Play Store 탭에 등록된 패키지가 없습니다.') : 'Play 계정을 불러오고 있습니다.') + '</p>';
}

/** runs.create input from the form's values; throws a person-readable Error when incomplete. */
export function newRunPayload(values) {
  const template = values.flowType === 'improve' ? 'improve' : 'new-app';
  const assignments = Object.fromEntries(TEMPLATE_STAGES[template].map((id) => [id, { agent: values.agent, reviewer: values.reviewer }]));
  const data = { template, goal: values.goal, projectId: values.projectId, assignments,
    maxConcurrency: Number(values.maxConcurrency), maxAttempts: Number(values.maxAttempts), maxRepairLoops: Number(values.maxRepairLoops) };
  if (values.baseBranch?.trim()) data.baseBranch = values.baseBranch.trim();
  if (template === 'improve') {
    data.areas = AREAS.map(([id]) => id).filter((id) => values['area_' + id]);
    if (!data.areas.length) throw new Error('개선 영역을 하나 이상 고르세요.');
    if (values.playApp) {
      const [accountId, packageName] = String(values.playApp).split('|');
      data.playLink = { accountId, packageName };
    }
  }
  return data;
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
