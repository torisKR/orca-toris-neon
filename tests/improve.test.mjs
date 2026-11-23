import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, templateGraph, IMPROVE_STAGE_IDS, IMPROVE_KINDS } from '../src/engine.mjs';
import { KIND_LABELS, KIND_DONE, UPDATE_RULE, IMPROVE_BRIEFS, improvementContext, prepareImprovement, billingSkillInstruction } from '../src/improve.mjs';
import { proposedProducts, catalogNotice, productCatalogApproval } from '../src/catalog.mjs';
import { buildNodePrompt } from '../src/prompt.mjs';

const NOW = '2026-11-23T01:00:00.000Z';
const playLink = { accountId: 'acc-1', accountName: 'Toris', packageName: 'com.example.water', status: 'published',
  tracks: [{ track: 'production', versionCodes: [42], state: 'published' }], observedAt: NOW };
function improveRun(kind = 'feature', options = { design: true, payments: true }, extra = {}) {
  const run = createRun({ id: 'r1', goal: '물주기 앱에 프리미엄 테마와 알림 기능을 넣고 싶어요.', now: NOW, nodes: templateGraph('improve', { kind, ...options }) });
  return { ...run, template: 'improve', improvement: { kind, options, projectName: 'water_garden', playLink, ...extra }, workspacePath: '/w', jobs: [] };
}
const node = (run, id) => run.nodes.find((item) => item.id === id);
const job = (id, phase = 'work') => ({ runId: 'r1', nodeId: id, nonce: 'n-' + id, phase, attempt: 1, agent: 'claude', receiptDirectory: '/r/' + id, receiptPath: '/r/' + id + '/result.json' });

test('every improvement kind has a label and its own done criteria; store listing and policy checks change no source', () => {
  for (const kind of Object.keys(IMPROVE_KINDS)) {
    assert.ok(KIND_LABELS[kind], kind + ' label');
    assert.ok(KIND_DONE[kind]?.length > 20, kind + ' done criteria');
  }
  assert.match(KIND_DONE.listing, /실제 앱/);
  assert.match(KIND_DONE.listing, /시안/);
  assert.match(KIND_DONE.policy, /바꾸지/);
  assert.match(improvementContext(improveRun('policy', { design: false, payments: false })), /정책·권한 점검/);
});

test('every stage of the improvement template has an update brief', () => {
  for (const id of IMPROVE_STAGE_IDS) assert.ok(IMPROVE_BRIEFS[id]?.length > 40, id);
  assert.match(IMPROVE_BRIEFS.identity, /applicationId|패키지/);
  assert.match(IMPROVE_BRIEFS.identity, /"identity"/);
  assert.match(IMPROVE_BRIEFS.reproduce, /실패/);
  assert.match(IMPROVE_BRIEFS.measure, /같은 조건|환경/);
  assert.match(IMPROVE_BRIEFS.diagnose, /3~5/);
  assert.match(IMPROVE_BRIEFS.build, /특성화 테스트|characterization/);
  assert.match(IMPROVE_BRIEFS.monetization, /acknowledge|확인\(acknowledge\)/);
  assert.match(IMPROVE_BRIEFS.monetization, /복원/);
  assert.match(IMPROVE_BRIEFS.monetization, /보류|pending/);
  assert.match(IMPROVE_BRIEFS.internal, /versionCode/);
});

test('an update run\'s briefs say it is a shipped app, name the areas and the linked Play package', () => {
  const run = improveRun();
  for (const id of ['identity', 'plan', 'build', 'monetization', 'test']) {
    const prompt = buildNodePrompt(run, node(run, id), job(id));
    assert.match(prompt, new RegExp(UPDATE_RULE.slice(0, 20)), id);
    assert.ok(prompt.includes(IMPROVE_BRIEFS[id].slice(0, 30)), id + ' uses its update brief');
  }
  const context = improvementContext(run);
  assert.match(context, new RegExp(KIND_LABELS.feature));
  assert.match(context, new RegExp(KIND_DONE.feature.slice(0, 15)));
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

test('a linked app whose release was rejected gets no fix run without the pasted reason; a policy check or diagnosis may run', async () => {
  const rejected = deps({ app: { ...playLink, status: 'rejected' } });
  const input = { projectId: 'p1', kind: 'bugfix', playLink: { accountId: 'acc-1', packageName: 'com.example.water' } };
  await assert.rejects(prepareImprovement(input, rejected), /반려 사유/);
  assert.equal((await prepareImprovement({ ...input, rejectionReason: 'Policy: 권한 고지 누락' }, rejected)).kind, 'bugfix');
  assert.equal((await prepareImprovement({ ...input, kind: 'policy' }, rejected)).kind, 'policy');
  assert.equal((await prepareImprovement(input, rejected, { diagnose: true })).kind, null);
});

test('an improvement needs an existing local repository with commits, a known kind and, if linked, a known Play package', async () => {
  const ok = await prepareImprovement({ projectId: 'p1', kind: 'feature', options: { payments: true }, playLink: { accountId: 'acc-1', packageName: 'com.example.water' } }, deps());
  assert.equal(ok.kind, 'feature');
  assert.deepEqual(ok.options, { design: false, payments: true });
  assert.equal(ok.improvement.playLink.packageName, 'com.example.water');
  assert.equal(ok.improvement.projectName, 'water_garden');
  assert.equal((await prepareImprovement({ projectId: 'p1', kind: 'bugfix' }, deps())).improvement.playLink, null);
  assert.equal((await prepareImprovement({ projectId: 'p1' }, deps(), { diagnose: true })).kind, null, 'diagnosis needs no kind');
  await assert.rejects(prepareImprovement({ projectId: 'p1', kind: 'bugfix' }, deps({ hasCommit: false })), /커밋/);
  await assert.rejects(prepareImprovement({ projectId: 'nope', kind: 'bugfix' }, deps()), /프로젝트/);
  await assert.rejects(prepareImprovement({ projectId: 'p1', kind: 'bugfix' }, deps({ projects: [{ id: 'p1', hostId: 'ssh:box', path: '/repo' }] })), /로컬/);
  await assert.rejects(prepareImprovement({ projectId: 'p1' }, deps()), /개선 종류/);
  await assert.rejects(prepareImprovement({ projectId: 'p1', kind: 'bugfix', options: { payments: true } }, deps()), /기능 추가/);
  await assert.rejects(prepareImprovement({ projectId: 'p1', kind: 'bugfix', playLink: { accountId: 'acc-1', packageName: 'not a package' } }, deps()), /패키지/);
  await assert.rejects(prepareImprovement({ projectId: 'p1', kind: 'bugfix', playLink: { accountId: 'acc-2', packageName: 'com.example.water' } }, deps()), /등록된 패키지/);
});

test('the identity report reaches every later brief; touched stored data makes the old-data check a required item', () => {
  const run = improveRun('bugfix', {});
  node(run, 'identity').status = 'passed';
  node(run, 'identity').report = { outcome: 'passed', summary: 'Kotlin/Compose 앱, Room DB 사용',
    identity: { stack: 'Kotlin/Compose', packageName: 'com.example.water', buildTarget: './gradlew assembleDebug', storedData: true } };
  for (const id of ['reproduce', 'build', 'test']) {
    const prompt = buildNodePrompt(run, node(run, id), job(id));
    assert.match(prompt, /Kotlin\/Compose/, id);
    assert.match(prompt, /다른 스택으로 다시 만들지/, id);
    assert.match(prompt, /기존 사용자 데이터가 새 버전에서 열리는지/, id);
  }
  node(run, 'identity').report.identity.storedData = false;
  assert.doesNotMatch(buildNodePrompt(run, node(run, 'build'), job('build')), /기존 사용자 데이터가 새 버전에서 열리는지/);
});

function withProducts(run) {
  node(run, 'plan').report = { outcome: 'passed', products: [{ productId: 'old_plan_id', type: 'inapp', price: '₩1,000' }] };
  node(run, 'monetization').report = { outcome: 'passed', model: 'one-time unlock',
    products: [{ productId: 'premium_unlock', type: 'inapp', price: '₩3,900', title: '프리미엄' }, { productId: 'pro.monthly', type: 'subs', price: '₩2,900/월', basePlanId: 'monthly' }] };
  return run;
}

test('the products to create come from the passed monetization report, falling back to the plan', () => {
  const run = withProducts(improveRun('feature', { payments: true }));
  assert.deepEqual(proposedProducts(run).map((item) => item.productId), ['premium_unlock', 'pro.monthly']);
  node(run, 'monetization').report = null;
  assert.deepEqual(proposedProducts(run).map((item) => item.productId), ['old_plan_id']);
});

test('the stop notice says exactly what to create in Play Console and what waits on it', () => {
  const notice = catalogNotice(withProducts(improveRun('feature', { payments: true })));
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
  const run = withProducts(improveRun('feature', { payments: true }));
  const input = { nodeId: 'catalog', note: 'Play Console에 두 상품을 등록하고 활성화했습니다.', productCatalog: { confirmed: ['premium_unlock', 'pro.monthly'] } };
  const { productCatalog } = productCatalogApproval(run, input);
  assert.deepEqual(productCatalog.products.map((item) => item.productId), ['premium_unlock', 'pro.monthly']);
  assert.throws(() => productCatalogApproval(run, { ...input, productCatalog: { confirmed: ['premium_unlock'] } }), /pro\.monthly/);
  assert.throws(() => productCatalogApproval(run, { ...input, note: '했음' }), /메모/);
  assert.throws(() => productCatalogApproval(run, { ...input, nodeId: 'internal' }), /상품 등록/);
  assert.throws(() => productCatalogApproval(run, { ...input, productCatalog: undefined }), /상품/);
});

test('a follow-up run\'s briefs carry the previous result', () => {
  const run = improveRun('maintenance', {}, { parent: { runId: 'run-prev', summary: '바뀐 것: 중복 예약 제거' } });
  assert.match(buildNodePrompt(run, node(run, 'build'), job('build')), /이전 결과\(run-prev\)[\s\S]*중복 예약 제거/);
});

test('every brief asks for the result-card fields; reviews must class a non-pass', () => {
  const run = improveRun('bugfix', {});
  const work = buildNodePrompt(run, node(run, 'build'), job('build'));
  for (const field of ['"changes"', '"criteria"', '"beforeAfter"', '"notVerified"', '"label"', 'screenshot', 'mockup']) assert.ok(work.includes(field), field);
  const review = buildNodePrompt(run, node(run, 'test'), { ...job('test', 'review'), sourceFingerprint: 'f' });
  assert.match(review, /"failureClass"/);
  for (const value of ['"code"', '"check"', '"external"']) assert.ok(review.includes(value), value);
});
