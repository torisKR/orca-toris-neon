import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, templateGraph, IMPROVE_GRAPH } from '../src/engine.mjs';
import { AREA_LABELS, UPDATE_RULE, IMPROVE_BRIEFS, improvementContext, prepareImprovement, billingSkillInstruction } from '../src/improve.mjs';
import { proposedProducts, catalogNotice, productCatalogApproval } from '../src/catalog.mjs';
import { buildNodePrompt } from '../src/prompt.mjs';

const NOW = '2026-11-23T01:00:00.000Z';
const playLink = { accountId: 'acc-1', accountName: 'Toris', packageName: 'com.example.water', status: 'published',
  tracks: [{ track: 'production', versionCodes: [42], state: 'published' }], observedAt: NOW };
function improveRun(areas = ['design', 'features', 'payments'], extra = {}) {
  const run = createRun({ id: 'r1', goal: '물주기 앱에 프리미엄 테마와 알림 기능을 넣고 싶어요.', now: NOW, nodes: templateGraph('improve', { areas }) });
  return { ...run, template: 'improve', improvement: { areas, projectName: 'water_garden', playLink, ...extra }, workspacePath: '/w', jobs: [] };
}
const node = (run, id) => run.nodes.find((item) => item.id === id);
const job = (id, phase = 'work') => ({ runId: 'r1', nodeId: id, nonce: 'n-' + id, phase, attempt: 1, agent: 'claude', receiptDirectory: '/r/' + id, receiptPath: '/r/' + id + '/result.json' });

test('every stage of the improvement template has an update brief', () => {
  for (const { id } of IMPROVE_GRAPH) assert.ok(IMPROVE_BRIEFS[id]?.length > 40, id);
  assert.match(IMPROVE_BRIEFS.audit, /versionCode/);
  assert.match(IMPROVE_BRIEFS.audit, /서명/);
  assert.match(IMPROVE_BRIEFS.build, /특성화 테스트|characterization/);
  assert.match(IMPROVE_BRIEFS.monetization, /acknowledge|확인\(acknowledge\)/);
  assert.match(IMPROVE_BRIEFS.monetization, /복원/);
  assert.match(IMPROVE_BRIEFS.monetization, /보류|pending/);
  assert.match(IMPROVE_BRIEFS.internal, /versionCode/);
});

test('an update run\'s briefs say it is a shipped app, name the areas and the linked Play package', () => {
  const run = improveRun();
  for (const id of ['audit', 'plan', 'build', 'monetization', 'test', 'release']) {
    const prompt = buildNodePrompt(run, node(run, id), job(id));
    assert.match(prompt, new RegExp(UPDATE_RULE.slice(0, 20)), id);
    assert.ok(prompt.includes(IMPROVE_BRIEFS[id].slice(0, 30)), id + ' uses its update brief');
  }
  const context = improvementContext(run);
  for (const label of Object.values(AREA_LABELS)) assert.match(context, new RegExp(label));
  assert.match(context, /com\.example\.water/);
  assert.match(context, /42/);
  assert.equal(improvementContext({ ...run, template: undefined }), '', 'a new-app run gets none of it');
  const plain = createRun({ id: 'r2', goal: '새 앱', now: NOW });
  assert.doesNotMatch(buildNodePrompt({ ...plain, jobs: [] }, plain.nodes[0], job('research')), new RegExp(UPDATE_RULE.slice(0, 20)));
});

test('the monetization brief lists only installed billing skills and otherwise sends the agent to the official docs', () => {
  const found = billingSkillInstruction({ phase: 'work', visual: { stage: 'monetization', skills: [{ name: 'paywalls', why: '페이월 화면' }] } });
  assert.match(found, /paywalls/);
  assert.match(found, /추측하지/);
  const none = billingSkillInstruction({ phase: 'work', visual: { stage: 'monetization', skills: [] } });
  assert.match(none, /developer\.android\.com/);
  assert.doesNotMatch(none, /paywalls/);
  assert.equal(billingSkillInstruction({ phase: 'work', visual: { stage: 'design', skills: [] } }), '');
});

function deps({ projects = [{ id: 'p1', name: 'water_garden', hostId: 'local', path: '/repo' }], hasCommit = true, app = playLink } = {}) {
  return {
    call: async (name) => { assert.equal(name, 'project.list'); return { projects }; },
    inspectRepository: async (repoPath) => { assert.equal(repoPath, '/repo'); return { hasCommit, hasBase: true }; },
    readPlayApp: async ({ accountId, packageName }) => {
      if (!app || accountId !== app.accountId || packageName !== app.packageName) throw Object.assign(new Error('이 계정에 등록된 패키지가 아닙니다.'), { code: 'invalid_input' });
      return app;
    },
  };
}

test('an improvement needs an existing local repository with commits, valid areas and, if linked, a known Play package', async () => {
  const ok = await prepareImprovement({ projectId: 'p1', areas: ['payments', 'design'], playLink: { accountId: 'acc-1', packageName: 'com.example.water' } }, deps());
  assert.equal(ok.template, 'improve');
  assert.deepEqual(ok.areas, ['design', 'payments'], 'areas in the template order');
  assert.equal(ok.improvement.playLink.packageName, 'com.example.water');
  assert.equal(ok.improvement.projectName, 'water_garden');
  assert.equal((await prepareImprovement({ projectId: 'p1', areas: ['features'] }, deps())).improvement.playLink, null);
  await assert.rejects(prepareImprovement({ projectId: 'p1', areas: ['features'] }, deps({ hasCommit: false })), /커밋/);
  await assert.rejects(prepareImprovement({ projectId: 'nope', areas: ['features'] }, deps()), /프로젝트/);
  await assert.rejects(prepareImprovement({ projectId: 'p1', areas: ['features'] }, deps({ projects: [{ id: 'p1', hostId: 'ssh:box', path: '/repo' }] })), /로컬/);
  await assert.rejects(prepareImprovement({ projectId: 'p1', areas: [] }, deps()), /개선 영역/);
  await assert.rejects(prepareImprovement({ projectId: 'p1', areas: ['features'], playLink: { accountId: 'acc-1', packageName: 'not a package' } }, deps()), /패키지/);
  await assert.rejects(prepareImprovement({ projectId: 'p1', areas: ['features'], playLink: { accountId: 'acc-2', packageName: 'com.example.water' } }, deps()), /등록된 패키지/);
});

function withProducts(run) {
  node(run, 'plan').report = { outcome: 'passed', products: [{ productId: 'old_plan_id', type: 'inapp', price: '₩1,000' }] };
  node(run, 'monetization').report = { outcome: 'passed', model: 'one-time unlock',
    products: [{ productId: 'premium_unlock', type: 'inapp', price: '₩3,900', title: '프리미엄' }, { productId: 'pro.monthly', type: 'subs', price: '₩2,900/월', basePlanId: 'monthly' }] };
  return run;
}

test('the products to create come from the passed monetization report, falling back to the plan', () => {
  const run = withProducts(improveRun(['payments']));
  assert.deepEqual(proposedProducts(run).map((item) => item.productId), ['premium_unlock', 'pro.monthly']);
  node(run, 'monetization').report = null;
  assert.deepEqual(proposedProducts(run).map((item) => item.productId), ['old_plan_id']);
});

test('the stop notice says exactly what to create in Play Console and what waits on it', () => {
  const notice = catalogNotice(withProducts(improveRun(['payments'])));
  assert.match(notice, /premium_unlock/);
  assert.match(notice, /일회성|inapp/);
  assert.match(notice, /₩3,900/);
  assert.match(notice, /pro\.monthly/);
  assert.match(notice, /monthly/);
  assert.match(notice, /판매자|결제 프로필/);
  assert.match(notice, /내부 테스트/);
  assert.ok(notice.length <= 900);
});

test('the catalog approval confirms every proposed product and only on the catalog stage', () => {
  const run = withProducts(improveRun(['payments']));
  const input = { nodeId: 'catalog', note: 'Play Console에 두 상품을 등록하고 활성화했습니다.', productCatalog: { confirmed: ['premium_unlock', 'pro.monthly'] } };
  const { productCatalog } = productCatalogApproval(run, input);
  assert.deepEqual(productCatalog.products.map((item) => item.productId), ['premium_unlock', 'pro.monthly']);
  assert.throws(() => productCatalogApproval(run, { ...input, productCatalog: { confirmed: ['premium_unlock'] } }), /pro\.monthly/);
  assert.throws(() => productCatalogApproval(run, { ...input, note: '했음' }), /메모/);
  assert.throws(() => productCatalogApproval(run, { ...input, nodeId: 'internal' }), /상품 등록/);
  assert.throws(() => productCatalogApproval(run, { ...input, productCatalog: undefined }), /상품/);
});
