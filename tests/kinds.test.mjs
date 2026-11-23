import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, claimNode, applyReport, templateGraph } from '../src/engine.mjs';
import { kindInstruction, kindFieldsOf, projectPlatform, WEB_RELEASE_DONE, WEB_NOTE } from '../src/kinds.mjs';
import { improvementContext } from '../src/improve.mjs';
import { buildNodePrompt } from '../src/prompt.mjs';

const NOW = '2026-11-23T01:00:00.000Z';
let sequence = 0;
function improveRun(kind, extra = {}) {
  const run = createRun({ id: 'r1', goal: '설정 화면을 정리합니다.', now: NOW, nodes: templateGraph('improve', { kind }) });
  return { ...run, template: 'improve', improvement: { kind, options: { design: false, payments: false }, projectName: 'water_garden', playLink: null, ...extra }, workspacePath: '/w', jobs: [] };
}
const node = (run, id) => run.nodes.find((item) => item.id === id);
const job = (id, phase = 'work') => ({ runId: 'r1', nodeId: id, nonce: 'n-' + id, phase, attempt: 1, agent: 'claude', receiptDirectory: '/r/' + id, receiptPath: '/r/' + id + '/result.json' });
const conditions = (overrides = {}) => ({ device: 'Pixel 7 에뮬레이터', size: '1080x2400', language: 'ko-KR', data: '샘플 식물 3개', ...overrides });
const measurement = (values, overrides = {}) => ({ scenario: '콜드 스타트 → 첫 화면', environment: 'Pixel 6 · release · 메모 500개', samples: values.length,
  metrics: [{ name: '첫 화면 표시', unit: 'ms', better: 'lower', values }], ...overrides });

/** Claims `id` for work and applies a passed report with `extra` fields; returns the run or throws. */
function passWork(run, id, extra = {}, evidence = [{ kind: 'artifact', path: '/r/' + id + '/notes.md' }]) {
  const nonce = 'c-' + (++sequence);
  const claimed = claimNode(run, id, { nonce, now: NOW });
  return applyReport(claimed, id, { runId: run.id, nodeId: id, phase: 'work', nonce, attempt: 1, outcome: 'passed', summary: id + ' 완료', evidence, ...extra }, { now: NOW });
}
/** Marks every stage before `id` as passed, with the given reports. */
function passedUpTo(run, id, reports = {}) {
  const next = structuredClone(run);
  for (const item of next.nodes) {
    if (item.id === id) break;
    Object.assign(item, { status: 'passed', report: { outcome: 'passed', summary: item.id, evidence: [], ...(reports[item.id] ?? {}) } });
  }
  return next;
}
const screenshot = (name = 'before.png') => ({ kind: 'artifact', path: '/r/' + name, label: 'screenshot', description: '설정 화면' });

test('the design brief asks for labelled real-app screenshots and the comparison conditions', () => {
  // Arrange
  const run = improveRun('design');
  // Act
  const design = kindInstruction(run, node(run, 'design'), job('design'));
  const verify = kindInstruction(passedUpTo(run, 'test', { design: { comparison: { before: conditions() } } }), node(run, 'test'), job('test'));
  // Assert
  assert.match(design, /"screenshot"/);
  assert.match(design, /"mockup"/);
  assert.match(design, /시안/);
  assert.match(design, /"comparison"/);
  assert.match(design, /기기.*화면 크기.*언어.*데이터/s);
  assert.match(verify, /같은 기기·화면 크기·언어·데이터/);
  assert.match(verify, /Pixel 7 에뮬레이터/, 'the test brief repeats the before conditions to match');
});

test('a design stage cannot pass without a real-app screenshot, labelled images and the before conditions', () => {
  // Arrange
  const run = passedUpTo(improveRun('design'), 'design');
  // Act / Assert
  assert.throws(() => passWork(run, 'design', { comparison: { before: conditions() } }), /screenshot/);
  assert.throws(() => passWork(run, 'design', { comparison: { before: conditions() } }, [screenshot(), { kind: 'artifact', path: '/r/new.png' }]), /label/);
  assert.throws(() => passWork(run, 'design', {}, [screenshot()]), /comparison/);
  assert.throws(() => passWork(run, 'design', { comparison: { before: conditions({ language: '' }) } }, [screenshot()]), /language/);
  const passed = passWork(run, 'design', { comparison: { before: conditions() } }, [screenshot(), { kind: 'artifact', path: '/r/mock.png', label: 'mockup' }]);
  assert.deepEqual(node(passed, 'design').report.comparison, { before: conditions() });
});

test('a design test stage needs the after screenshot and its conditions; mismatched conditions still pass for the card to flag', () => {
  // Arrange
  const run = passedUpTo(improveRun('design'), 'test', { design: { comparison: { before: conditions() } } });
  // Act / Assert
  assert.throws(() => passWork(run, 'test', {}, [screenshot('after.png')]), /comparison/);
  const passed = passWork(run, 'test', { comparison: { after: conditions({ language: 'en-US' }) } }, [screenshot('after.png')]);
  assert.equal(node(passed, 'test').report.comparison.after.language, 'en-US');
});

test('the performance measure stage records scenario, environment, sample count and every measured number', () => {
  // Arrange
  const run = passedUpTo(improveRun('performance'), 'measure');
  // Act / Assert
  assert.match(kindInstruction(run, node(run, 'measure'), job('measure')), /"measurement".*"samples".*"values"/s);
  assert.throws(() => passWork(run, 'measure'), /measurement/);
  assert.throws(() => passWork(run, 'measure', { measurement: { ...measurement([900, 950]), samples: 3 } }), /samples/);
  assert.throws(() => passWork(run, 'measure', { measurement: measurement([900, 'fast']) }), /숫자/);
  assert.throws(() => passWork(run, 'measure', { measurement: { ...measurement([900]), scenario: '' } }), /scenario/);
  const passed = passWork(run, 'measure', { measurement: measurement([900, 950, 1000]) });
  assert.deepEqual(node(passed, 'measure').report.measurement.metrics[0].values, [900, 950, 1000]);
});

test('the performance test re-measures under the baseline conditions, named in its brief and enforced on pass', () => {
  // Arrange
  const run = passedUpTo(improveRun('performance'), 'test', { measure: { measurement: measurement([900, 950, 1000]) } });
  // Act
  const brief = kindInstruction(run, node(run, 'test'), job('test'));
  // Assert
  assert.match(brief, /콜드 스타트 → 첫 화면/);
  assert.match(brief, /Pixel 6 · release · 메모 500개/);
  assert.match(brief, /표본 3회/);
  assert.match(brief, /개선율.*직접 적지 마세요/);
  assert.throws(() => passWork(run, 'test'), /measurement/);
  assert.throws(() => passWork(run, 'test', { measurement: measurement([700, 710, 720], { environment: 'Pixel 8 · debug' }) }), /같은 조건/);
  assert.throws(() => passWork(run, 'test', { measurement: measurement([700, 710]) }), /같은 조건/);
  assert.throws(() => passWork(run, 'test', { measurement: { ...measurement([700, 710, 720]), metrics: [{ name: '다른 지표', unit: 'ms', better: 'lower', values: [1, 2, 3] }] } }), /첫 화면 표시/);
  const seconds = { ...measurement([0.7, 0.71, 0.72]), metrics: [{ name: '첫 화면 표시', unit: 's', better: 'lower', values: [0.7, 0.71, 0.72] }] };
  assert.throws(() => passWork(run, 'test', { measurement: seconds }), /unit과 better/, 'a different unit would make the rate meaningless');
  assert.equal(node(passWork(run, 'test', { measurement: measurement([700, 710, 720]) }), 'test').status, 'review');
});

test('a release update links commit, artifact, package, track and versionCode on its submission stages', () => {
  // Arrange
  const run = passedUpTo(improveRun('release'), 'internal');
  node(run, 'internal').approval = { at: NOW, note: '사용자가 준비를 승인했습니다.' }; // the existing gate, given by a person
  const link = { commit: 'a1b2c3d4e5f6', artifact: 'app/build/outputs/bundle/release/app-release.aab', packageName: 'com.example.water', track: 'internal', versionCode: 43 };
  // Act / Assert
  assert.match(kindInstruction(run, node(run, 'internal'), job('internal')), /"releaseLink"/);
  assert.throws(() => passWork(run, 'internal'), /releaseLink/);
  assert.throws(() => passWork(run, 'internal', { releaseLink: { ...link, commit: 'main' } }), /commit/);
  assert.throws(() => passWork(run, 'internal', { releaseLink: { ...link, packageName: 'water' } }), /패키지/);
  assert.throws(() => passWork(run, 'internal', { releaseLink: { ...link, versionCode: 0 } }), /versionCode/);
  assert.equal(node(passWork(run, 'internal', { releaseLink: link }), 'internal').report.releaseLink.versionCode, '43');
});

test('the release test brief re-verifies only what changed since the last verified commit, or everything without one', () => {
  // Arrange
  const verified = { runId: 'old-run', commit: 'f00dfeed1234567890abcdef1234567890abcdef', at: NOW };
  const withHistory = improveRun('release', { lastVerified: verified });
  const without = improveRun('release');
  // Act
  const scoped = kindInstruction(withHistory, node(withHistory, 'test'), job('test'));
  const full = kindInstruction(without, node(without, 'test'), job('test'));
  // Assert
  assert.match(scoped, /f00dfeed1234/);
  assert.match(scoped, /git diff --stat f00dfeed1234567890abcdef1234567890abcdef\.\.HEAD/);
  assert.match(scoped, /바뀐 것만/);
  assert.match(full, /전체를 다시 검증/);
});

test('submission stays with a person: release update submission stages keep the existing approval gate', () => {
  // Arrange / Act
  const graph = templateGraph('improve', { kind: 'release' });
  // Assert
  for (const id of ['internal', 'release']) assert.equal(graph.find((item) => item.id === id).requiresApproval, true, id);
  assert.match(kindInstruction(improveRun('release'), node(improveRun('release'), 'release'), job('release')), /승인한 대상에만/);
});

test('web projects never get Android policy or Play stages', () => {
  // Arrange / Act
  const release = templateGraph('improve', { kind: 'release', web: true }).map((item) => item.id);
  const feature = templateGraph('improve', { kind: 'feature', design: true, web: true }).map((item) => item.id);
  // Assert
  assert.deepEqual(release, ['identity', 'test']);
  assert.deepEqual(templateGraph('improve', { kind: 'release', web: true })[1].deps, ['identity']);
  assert.ok(!feature.some((id) => ['policy', 'listing', 'catalog', 'internal', 'release', 'monetization'].includes(id)));
  assert.throws(() => templateGraph('improve', { kind: 'feature', payments: true, web: true }), /웹/);
  assert.deepEqual(templateGraph('improve', { kind: 'release' }).map((item) => item.id), ['identity', 'test', 'policy', 'listing', 'internal', 'release'], 'Android keeps its Play stages');
});

test('a web project is told its release update has no Play stages', () => {
  // Arrange
  const run = { ...improveRun('release', { platform: 'web' }), nodes: templateGraph('improve', { kind: 'release', web: true }) };
  // Act
  const context = improvementContext(run);
  // Assert
  assert.ok(context.includes(WEB_RELEASE_DONE));
  assert.ok(context.includes(WEB_NOTE), 'the Android-only lines of shared briefs are marked as not applying');
  assert.doesNotMatch(context, /트랙·버전이 서로 연결|Play 연결 없음/);
});

test('a project is web only with a readable package.json and no app marker or mobile-app dependency', async () => {
  // Arrange
  const io = (names, manifest) => ({ readdir: async () => names, readHead: async () => (typeof manifest === 'string' ? manifest : JSON.stringify(manifest)) });
  // Act / Assert
  assert.equal(await projectPlatform('/Users/me/site', io(['package.json', 'src'], { dependencies: { react: '18' } })), 'web');
  assert.equal(await projectPlatform('/Users/me/app', io(['package.json', 'android', 'ios'], { dependencies: { react: '18' } })), 'app', 'a React Native app has android/ at the root');
  assert.equal(await projectPlatform('/Users/me/app', io(['package.json'], { dependencies: { expo: '51' } })), 'app');
  assert.equal(await projectPlatform('/Users/me/app', io(['package.json'], { devDependencies: { '@capacitor/core': '6' } })), 'app');
  assert.equal(await projectPlatform('/Users/me/game', io(['project.godot', 'package.json'], {})), 'app');
  assert.equal(await projectPlatform('/Users/me/flutter', io(['pubspec.yaml'], {})), 'app');
  assert.equal(await projectPlatform('/Users/me/site', io(['package.json'], '{broken')), null, 'an unreadable manifest keeps the Play stages');
  assert.equal(await projectPlatform('/Users/me/tool', io(['pyproject.toml'], {})), null);
  assert.equal(await projectPlatform('/Users/me/gone', { readdir: async () => { throw new Error('ENOENT'); } }), null);
});

test('kind report fields are optional, normalized only on a passed report, and dropped from one that did not pass', () => {
  assert.deepEqual(kindFieldsOf({ outcome: 'passed' }), {});
  assert.deepEqual(kindFieldsOf({ outcome: 'passed', measurement: null }), {});
  assert.deepEqual(JSON.parse(JSON.stringify(kindFieldsOf({ outcome: 'failed', measurement: '잴 수 없음' }))), {}, 'an honest failure needs no measurement');
  assert.throws(() => kindFieldsOf({ outcome: 'passed', comparison: {} }), /before.*after|after.*before/);
  assert.throws(() => kindFieldsOf({ outcome: 'passed', measurement: measurement([1], { metrics: [{ name: 'x', unit: 'ms', better: 'faster', values: [1] }] }) }), /better/);
});

test('the kind instruction reaches the stage prompt, and other kinds or templates get none', () => {
  // Arrange
  const run = passedUpTo(improveRun('performance'), 'measure');
  // Act
  const prompt = buildNodePrompt(run, node(run, 'measure'), job('measure'));
  // Assert
  assert.match(prompt, /"measurement"/);
  assert.equal(kindInstruction(improveRun('bugfix'), node(improveRun('bugfix'), 'build'), job('build')), '');
  assert.equal(kindInstruction({ ...improveRun('design'), template: 'new-app' }, node(improveRun('design'), 'design'), job('design')), '');
});

test('a review is told to check the kind proof against the real artifacts, not to fill it', () => {
  const run = passedUpTo(improveRun('design'), 'design');
  const review = kindInstruction(run, node(run, 'design'), job('design', 'review'));
  assert.match(review, /검토/);
  assert.doesNotMatch(review, /적으세요/);
});
