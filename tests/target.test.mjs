import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, claimNode, applyReport, templateGraph } from '../src/engine.mjs';
import { buildNodePrompt } from '../src/prompt.mjs';
import { isReportFormError, REPORT_FIX_REASON_CHARS } from '../src/reportfix.mjs';
import { sampleTarget, inferredTarget } from './fixtures/target.mjs';
import { sampleFindings } from './fixtures/research.mjs';
import { targetOf, targetContract, targetInstruction, TARGET_EXAMPLE } from '../src/target.mjs';

const NOW = Date.parse('2026-11-28T09:00:00Z');
const newApp = () => createRun({ id: 'run-t', goal: '습관 앱', projectId: 'p1', now: NOW, nodes: templateGraph('new-app') });
const improveRun = (kind, options = {}) => ({ ...createRun({ id: 'run-i', goal: '기존 앱 개선', projectId: 'p1', now: NOW, nodes: templateGraph('improve', { kind, ...options }) }),
  template: 'improve', improvement: { kind, options, projectName: '샘플 앱' } });
const refusal = (thunk) => { try { thunk(); } catch (error) { return error; } return null; };

/** Applies a report from `nodeId` (claimed for `phase`) to `run`; earlier stages are marked passed. */
function reportOn(run, nodeId, extra, { phase = 'work', outcome = 'passed' } = {}) {
  const index = run.nodes.findIndex((node) => node.id === nodeId);
  const nodes = run.nodes.map((node, at) => {
    if (at < index) return { ...node, status: 'passed', report: { outcome: 'passed', summary: '앞 단계' } };
    if (at === index && phase === 'review') return { ...node, status: 'review', attempts: 1, report: { outcome: 'passed', summary: '작업', target: sampleTarget() } };
    return node;
  });
  const claimed = claimNode({ ...run, nodes }, nodeId, { phase, nonce: 'n-1', now: NOW });
  const report = { runId: run.id, nodeId, nonce: 'n-1', attempt: 1, phase, outcome, summary: '마쳤다',
    evidence: [{ kind: 'artifact', path: nodeId + '.md' }], ...(phase === 'review' ? { sourceFingerprint: 'x' } : {}), ...extra };
  return () => applyReport(claimed, nodeId, report, { now: NOW + 1 });
}
const briefReport = (extra, options) => reportOn(newApp(), 'brief', extra, options);
const stored = (run, id) => run.nodes.find((node) => node.id === id).report;

test('a passed brief report with a valid target is stored normalized', () => {
  assert.deepEqual(stored(briefReport({ target: sampleTarget() })(), 'brief').target, sampleTarget());
});

test('a passed brief report without a target is refused as a report-form error with a copyable example', () => {
  const error = refusal(briefReport({}));
  assert.ok(error, 'refused');
  assert.equal(error.code, 'invalid_report');
  assert.equal(isReportFormError(error), true, 'the same agent fixes result.json');
  for (const part of [/"target"/, /"primaryUser"/, /"avoid"/, /"signals"/, /## 타겟/, /예:/]) assert.match(error.message, part);
  assert.ok(error.message.length < REPORT_FIX_REASON_CHARS, 'fits one report-fix request: ' + error.message.length);
});

test('the example in the contract is valid JSON that the contract accepts as written', () => {
  assert.doesNotThrow(() => targetOf(JSON.parse(TARGET_EXAMPLE)));
  assert.ok(targetContract().includes(TARGET_EXAMPLE));
  assert.doesNotMatch(TARGET_EXAMPLE, /@|\/Users\//, 'sample values only');
});

test('a vague primaryUser is refused with a message that says what a specific one has', () => {
  const vague = (primaryUser) => briefReport({ target: { ...sampleTarget(), primaryUser } });
  for (const value of ['누구나 쉽게 쓰는 습관 관리가 필요한 사람이라면 누구에게나 맞는 앱을 원하는 분들', '모든 사용자', '일반 사용자를 위한 깔끔하고 편리한 습관 기록 앱을 원하는 사람들입니다',
    'Everyone who wants to build better habits every single day']) {
    assert.throws(vague(value), { code: 'invalid_report', message: /primaryUser[^]*(누구나|모든 사용자|일반 사용자|구체)/ }, value);
  }
  for (const value of ['20~30대', '20대 직장인', '10대 이상 남녀']) {
    assert.throws(vague(value), { code: 'invalid_report', message: /primaryUser/ }, value);
  }
  assert.throws(vague('20~30대 남녀 사용자'), { message: /나이대/ });
  assert.throws(vague('직장인'), { message: /상황/ }, 'too short to name a situation');
});

test('malformed targets are refused, each with a message naming the broken field', () => {
  const bad = (patch) => briefReport({ target: { ...sampleTarget(), ...patch } });
  const cases = [
    [{ notFor: [] }, /target\.notFor는 1~3개/], [{ notFor: Array(4).fill('사람') }, /target\.notFor는 1~3개/],
    [{ job: '' }, /target\.job/], [{ promise: 'x'.repeat(201) }, /target\.promise/],
    [{ decisions: ['하나', '둘'] }, /target\.decisions는 3~6개/],
    [{ voice: '담담하게' }, /target\.voice는 객체/], [{ voice: { tone: '담담', examples: ['하나'] } }, /target\.voice\.examples는 2~3개/],
    [{ look: { direction: '밝게' } }, /target\.look\.why/],
    [{ avoid: ['하나', '둘'] }, /target\.avoid는 3~8개/], [{ avoid: Array(9).fill('금지') }, /target\.avoid는 3~8개/],
    [{ signals: ['하나'] }, /target\.signals는 2~4개/],
  ];
  for (const [patch, message] of cases) assert.throws(bad(patch), { code: 'invalid_report', message }, JSON.stringify(patch).slice(0, 80));
  assert.throws(briefReport({ target: [] }), { code: 'invalid_report', message: /^target는 객체/ });
  assert.throws(briefReport({ target: null }), { code: 'invalid_report', message: /^target는 객체/ }, 'one refusal, not a second "no target" one');
});

test('every target problem is named in one refusal, so one report-fix round is enough', () => {
  const error = refusal(briefReport({ target: { ...sampleTarget(), primaryUser: '모든 사용자', avoid: [], signals: undefined } }));
  assert.match(error.message, /고칠 곳 3개/);
  for (const part of [/primaryUser/, /target\.avoid/, /target\.signals/]) assert.match(error.message, part);
});

test('a failed or blocked brief, its review, and other stages need no target; another stage\'s target is not kept', () => {
  assert.doesNotThrow(briefReport({}, { outcome: 'failed' }));
  const blocked = briefReport({ target: { primaryUser: '' } }, { outcome: 'blocked' })();
  assert.equal(stored(blocked, 'brief').target, undefined);
  assert.doesNotThrow(briefReport({}, { phase: 'review' }));
  const design = reportOn(newApp(), 'design', { target: { primaryUser: '다른 단계의 값' } })();
  assert.equal(stored(design, 'design').target, undefined);
});

test('the identity of a design, feature or release improvement records the app\'s current target', () => {
  for (const kind of ['design', 'feature', 'release']) {
    const error = refusal(reportOn(improveRun(kind), 'identity', { identity: { stack: 'Flutter' } }));
    assert.ok(error, kind);
    assert.equal(isReportFormError(error), true);
    assert.match(error.message, /identity\.target/);
    assert.match(error.message, /\(추정\)/);
    const run = reportOn(improveRun(kind), 'identity', { identity: { stack: 'Flutter', target: inferredTarget() } })();
    assert.deepEqual(stored(run, 'identity').identity.target, inferredTarget(), 'only the five required fields are needed');
    assert.equal(stored(run, 'identity').identity.stack, 'Flutter');
  }
  assert.throws(reportOn(improveRun('design'), 'identity', { identity: { target: { ...inferredTarget(), look: undefined } } }), { message: /target\.look/ });
  for (const kind of ['bugfix', 'performance', 'maintenance', 'listing', 'policy']) {
    assert.doesNotThrow(reportOn(improveRun(kind), 'identity', { identity: { stack: 'Flutter' } }), kind);
  }
});

const job = (phase, nodeId) => ({ runId: 'run-t', nodeId, nonce: 'n', phase, attempt: 1, agent: 'codex', receiptDirectory: '/r', receiptPath: '/r/result.json', sourceFingerprint: 'f' });
const promptFor = (run, nodeId, phase = 'work') => buildNodePrompt(run, run.nodes.find((node) => node.id === nodeId), job(phase, nodeId));
const withStage = (run, id, report) => ({ ...run, nodes: run.nodes.map((node) => node.id === id ? { ...node, status: 'passed', report: { outcome: 'passed', summary: id, ...report } } : node) });
const planned = () => withStage(withStage(newApp(), 'research', { findings: sampleFindings() }), 'brief', { target: sampleTarget() });

test('the brief work prompt builds the target from the research findings and calls a generic target a defect', () => {
  const run = withStage(newApp(), 'research', { findings: sampleFindings() });
  const prompt = promptFor(run, 'brief');
  assert.ok(prompt.includes(targetContract()));
  for (const field of ['primaryUser', 'notFor', 'job', 'promise', 'decisions', 'voice', 'look', 'avoid', 'signals']) assert.match(prompt, new RegExp('"' + field + '"'), field);
  for (const word of ['targetUser', 'problem', 'competitors', 'differentiators']) assert.match(prompt, new RegExp(word), word);
  assert.ok(prompt.includes(sampleFindings().targetUser), 'the research target user is quoted');
  assert.match(prompt, /## 타겟/);
  assert.match(prompt, /일반적인 타겟[^\n]*결함/);
});

test('the brief review checks the target is specific and consistent with the research', () => {
  const prompt = promptFor(planned(), 'brief', 'review');
  assert.match(prompt, /타겟 검토/);
  assert.match(prompt, /research|조사/);
  assert.match(prompt, /"defect"/);
  assert.match(prompt, /## 타겟/);
});

test('design, assets, build and listing prompts quote the target the brief set', () => {
  const run = planned();
  const target = sampleTarget();
  const expected = {
    design: [target.primaryUser, target.promise, target.voice.examples[0], target.look.direction, target.avoid[0]],
    assets: [target.primaryUser, target.look.direction, target.avoid[0]],
    build: [target.primaryUser, target.decisions[0], target.voice.examples[1], target.avoid[1], target.signals[0]],
    listing: [target.primaryUser, target.promise, target.voice.tone, target.avoid[2]],
    test: [target.signals[0], target.signals[1]],
  };
  for (const [stage, texts] of Object.entries(expected)) {
    const prompt = promptFor(run, stage);
    assert.match(prompt, /제품 기획의 타겟/, stage);
    for (const text of texts) assert.ok(prompt.includes(text), stage + ': ' + text);
  }
  assert.doesNotMatch(promptFor(run, 'architecture'), /제품 기획의 타겟/, 'only the stages that make what the person sees');
});

test('design, assets and listing reviews check the output against the target; test review measures the signals', () => {
  const run = planned();
  for (const stage of ['design', 'assets', 'listing']) {
    const prompt = promptFor(run, stage, 'review');
    assert.match(prompt, /타겟 검토/, stage);
    assert.match(prompt, /avoid/, stage);
    assert.match(prompt, /지어낸 (수치|숫자)/, stage);
    assert.match(prompt, /어느 앱에나/, stage);
    assert.match(prompt, /"defect"/, stage);
    assert.match(prompt, /later/, stage);
  }
  const test = promptFor(run, 'test', 'review');
  assert.match(test, /signals/);
  assert.match(test, /notVerified/);
});

test('a missing or malformed target is said, not skipped', () => {
  const missing = withStage(newApp(), 'brief', {});
  const malformed = withStage(newApp(), 'brief', { target: { primaryUser: '모든 사용자' } });
  for (const run of [missing, malformed]) {
    for (const stage of ['design', 'build', 'listing', 'test']) assert.match(promptFor(run, stage), /타겟이 없거나 형식이 맞지 않습니다/, stage);
  }
  assert.match(targetInstruction(newApp(), newApp().nodes.find((node) => node.id === 'design'), job('work', 'design')), /통과하지 않음, 상태 pending/, 'a skipped or unpassed brief is named');
  assert.match(promptFor(malformed, 'design'), /primaryUser/, 'the reason a stored target is unusable is passed on');
  const custom = createRun({ id: 'run-c', goal: '앱', projectId: 'p1', now: NOW, nodes: [{ id: 'design', title: '디자인', deps: [], write: false }] });
  assert.equal(targetInstruction(custom, custom.nodes[0], job('work', 'design')), '', 'a graph without a brief has no target to follow');
});

test('an improvement of design, feature or release quotes the identity target so the app keeps its character', () => {
  const run = withStage(improveRun('design'), 'identity', { identity: { stack: 'Flutter', target: inferredTarget() } });
  const identity = promptFor(improveRun('design'), 'identity');
  assert.match(identity, /"target"/);
  assert.match(identity, /\(추정\)/);
  for (const stage of ['design', 'assets', 'build']) {
    const prompt = promptFor(run, stage);
    assert.match(prompt, /현재 타겟/, stage);
    assert.ok(prompt.includes(inferredTarget().primaryUser), stage);
  }
  assert.ok(promptFor(run, 'design').includes(inferredTarget().promise));
  assert.equal(promptFor(run, 'build').split(inferredTarget().promise).length - 1, 0, 'build quotes its own fields once, not a JSON dump of the identity target');
  const bugfix = withStage(improveRun('bugfix'), 'identity', { identity: { stack: 'Flutter' } });
  assert.doesNotMatch(promptFor(bugfix, 'build'), /타겟/, 'other kinds are unchanged');
  assert.doesNotMatch(promptFor(improveRun('bugfix'), 'identity'), /"target"/);
});

test('targetOf keeps only the contract fields and trims text', () => {
  const value = targetOf({ ...sampleTarget(), extra: '버림', promise: '  ' + sampleTarget().promise + '  ', voice: { ...sampleTarget().voice, mood: 'x' } });
  assert.equal('extra' in value, false);
  assert.equal('mood' in value.voice, false);
  assert.equal(value.promise, sampleTarget().promise);
});

test('items with no content, broader generic wording, and a target on an improvement that does not follow it', () => {
  assert.throws(briefReport({ target: { ...sampleTarget(), avoid: ['(추정)', '-', '목표 설정 마법사로 시작하지 않는다'] } }), { code: 'invalid_report', message: /target\.avoid\[0\]가 내용 없이/ });
  assert.throws(briefReport({ target: { ...sampleTarget(), primaryUser: '전체 사용자 중 아침마다 루틴을 지키고 싶어 하는 직장인과 학생들입니다' } }), { message: /전체 사용자/ });
  assert.throws(briefReport({ target: { ...sampleTarget(), primaryUser: 'Everybody who commutes by subway and wants a morning routine' } }), { message: /Everybody/ });
  const bugfix = reportOn(improveRun('bugfix'), 'identity', { identity: { stack: 'Flutter', target: inferredTarget() } })();
  assert.equal(stored(bugfix, 'identity').identity.target, undefined, 'shown nowhere a later stage would not follow it');
  assert.equal(stored(bugfix, 'identity').identity.stack, 'Flutter');
});

test('ordinary words that start like a generic phrase are not refused', () => {
  for (const primaryUser of ['서울 도심에서 일하며 모든 분야 자료를 정리하려는 프리랜서 번역가로 지금은 메모 앱을 쓴다',
    '일반 인증서 발급 때문에 은행 앱을 자주 여는 자영업자, 지금은 수첩에 적어 둔다.',
    '이전 연령대 구분 없이 쓰던 종이 가계부를 대신할 은퇴 교사 부부가 저녁에 함께 쓴다',
    'A parent who wants everyone in the family to see the chore chart on the fridge tablet each evening']) {
    assert.doesNotThrow(briefReport({ target: { ...sampleTarget(), primaryUser } }), primaryUser);
  }
});
