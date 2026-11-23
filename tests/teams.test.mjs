import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEAMS, teamOf, stageView, agentRoster, collaboration, transitions, snapshotStates, relations,
  handsOffTo, teamLanes, elapsed, LEGACY_ECC_DEFAULTS as PANEL_LEGACY, eccOverride as panelOverride,
} from '../panel/teams.mjs';
import { DEFAULT_GRAPH, IMPROVE_STAGE_IDS, createRun, claimNode, templateGraph } from '../src/engine.mjs';
import { LEGACY_ECC_DEFAULTS, eccOverride } from '../src/ecc.mjs';

const NOW = '2026-11-19T05:00:00.000Z';
const fresh = () => createRun({ id: 'run', goal: '앱', agent: 'codex', reviewer: 'claude', now: NOW });
const node = (run, id) => run.nodes.find((item) => item.id === id);

test('every stage of both templates belongs to exactly one team with its own mark', () => {
  const ids = TEAMS.flatMap((team) => team.stages);
  assert.deepEqual([...ids].sort(), [...new Set([...DEFAULT_GRAPH.map((item) => item.id), ...IMPROVE_STAGE_IDS])].sort());
  assert.deepEqual(TEAMS.find((team) => team.id === 'money').stages, ['monetization', 'catalog']);
  assert.equal(TEAMS.find((team) => team.id === 'money').name, '수익화팀');
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(TEAMS.map((team) => team.mark)).size, TEAMS.length);
  assert.equal(teamOf('custom').id, 'other');
});

test('the panel reads ECC overrides exactly like the worker, legacy auto-filled values included', () => {
  assert.deepEqual(PANEL_LEGACY, LEGACY_ECC_DEFAULTS);
  for (const sample of [{ id: 'build' }, { id: 'build', eccAgent: 'ecc:tdd-guide' }, { id: 'build', eccAgent: 'ecc:planner' }, { id: 'assets', eccAgent: null }, { id: 'test', eccAgent: 'none' }]) {
    assert.equal(panelOverride(sample), eccOverride(sample), JSON.stringify(sample));
  }
});

test('stage view maps work, review, pass, failure and waiting from node data', () => {
  let run = fresh();
  run = claimNode(run, 'research', { nonce: 'n1', now: NOW });
  const working = stageView(run, node(run, 'research'));
  assert.equal(working.state, 'working');
  assert.equal(working.label, '작업 중');
  assert.equal(working.phase, 'work');
  assert.equal(working.attempt, 1);
  assert.equal(working.agent, 'codex');
  assert.equal(working.eccApplies, false, 'ECC applies only to claude');
  node(run, 'research').active.phase = 'review';
  const reviewing = stageView(run, node(run, 'research'));
  assert.equal(reviewing.state, 'reviewing');
  assert.equal(reviewing.agent, 'claude');
  assert.equal(reviewing.eccAgent, null, 'automatic until the worker records a shortlist');
  node(run, 'research').eccShortlist = { phase: 'review', agents: [{ name: 'ecc:code-reviewer', why: '검토' }], skills: [] };
  const advised = stageView(run, node(run, 'research'));
  assert.equal(advised.eccAgent, 'ecc:code-reviewer');
  assert.equal(advised.eccApplies, true);
  node(run, 'research').eccAgent = 'none';
  assert.equal(stageView(run, node(run, 'research')).eccApplies, false);
  assert.equal(stageView(run, { ...node(run, 'brief'), status: 'passed' }).state, 'passed');
  assert.equal(stageView(run, { ...node(run, 'brief'), status: 'failed', failureReason: '빌드 실패' }).message, '빌드 실패');
  assert.equal(stageView(run, node(run, 'brief')).state, 'waiting');
});

test('both tabs read the same job: an idle never-prompted agent is undelivered in the roster', () => {
  let run = fresh();
  run = claimNode(run, 'research', { nonce: 'n1', now: NOW });
  run.jobs = [{ nonce: 'n1', nodeId: 'research', state: 'running', agentState: 'done' }];
  assert.equal(stageView(run, node(run, 'research')).undelivered, true);
  const research = agentRoster(run)[0].members.filter((member) => member.view.id === 'research');
  assert.deepEqual(research.map((member) => member.live), ['undelivered', 'waiting']);
  run.jobs[0].promptSeen = true;
  assert.equal(agentRoster(run)[0].members[0].live, 'working');
  // Plugin-typed jobs: undelivered until the one-shot prompt record exists, whatever the agent reports.
  run.jobs[0] = { nonce: 'n1', nodeId: 'research', state: 'running', selfDelivery: true, agentState: 'done' };
  assert.equal(stageView(run, node(run, 'research')).undelivered, true);
  run.jobs[0].promptRecovery = { state: 'sent' };
  assert.equal(stageView(run, node(run, 'research')).undelivered, false);
});

test('the roster groups every stage worker and reviewer under its team', () => {
  const roster = agentRoster(fresh());
  assert.deepEqual(roster.map((entry) => entry.team.id), TEAMS.map((team) => team.id).filter((id) => id !== 'money'), 'a new app has no monetization lane');
  const update = createRun({ id: 'u', goal: '결제 추가', now: NOW, nodes: templateGraph('improve', { kind: 'feature', payments: true }) });
  assert.deepEqual(agentRoster(update).find((entry) => entry.team.id === 'money').members.map((member) => member.key), ['monetization:work', 'monetization:review', 'catalog:work', 'catalog:review']);
  assert.equal(roster.flatMap((entry) => entry.members).length, DEFAULT_GRAPH.length * 2);
  const run = fresh();
  node(run, 'research').status = 'review';
  assert.equal(agentRoster(run)[0].members[0].live, 'handed');
});

test('an idle run reports no live collaboration; QA feedback shows the repair loop', () => {
  const run = fresh();
  assert.deepEqual(collaboration(run).live, []);
  node(run, 'build').feedback = { summary: '로그인 버튼이 반응하지 않음' };
  run.repairLoops = 1;
  const state = collaboration(run);
  assert.equal(state.repairing, 'build');
  assert.equal(state.loops, 1);
  assert.match(stageView(run, node(run, 'build')).message, /수정 요청/);
});

test('transitions report only real changes: handoff, verdict, retry and start', () => {
  let run = fresh();
  assert.equal(transitions(null, run).size, 0, 'first render has no motion');
  const idle = snapshotStates(run);
  assert.equal(transitions(idle, run).size, 0, 'an unchanged run has no motion');
  run = claimNode(run, 'research', { nonce: 'n1', now: NOW });
  assert.equal(transitions(idle, run).get('research'), 'start');
  const working = snapshotStates(run);
  node(run, 'research').active = null;
  node(run, 'research').status = 'review';
  assert.equal(transitions(working, run).get('research'), 'handoff');
  const queued = snapshotStates(run);
  node(run, 'research').status = 'passed';
  assert.equal(transitions(queued, run).get('research'), 'verdict');
  const passed = snapshotStates(run);
  node(run, 'brief').feedback = { summary: 'x' };
  assert.equal(transitions(passed, run).get('brief'), 'retry');
});

test('relations and lane handoffs follow the dependency graph', () => {
  const run = fresh();
  assert.deepEqual(relations(run, 'build').upstream.map((item) => item.id), ['architecture', 'assets']);
  assert.deepEqual(relations(run, 'test').downstream.map((item) => item.id), ['policy', 'listing']);
  assert.deepEqual(handsOffTo(run, teamLanes(run)[0]).map((team) => team.id), ['arch', 'design']);
});

test('elapsed time is readable and never negative', () => {
  const start = Date.parse(NOW);
  assert.equal(elapsed(NOW, start + 42_000), '42초');
  assert.equal(elapsed(NOW, start + 192_000), '3분 12초');
  assert.equal(elapsed(NOW, start + 3_840_000), '1시간 4분');
  assert.equal(elapsed(NOW, start - 5000), '0초');
  assert.equal(elapsed(null, start), '');
});

test('a run title is the first meaningful goal line without /goal or markdown markers', async () => {
  const { goalTitle } = await import('../panel/kit.mjs');
  const goal = '/goal\n\n# **달빛 판타지** 수집형 RPG 만들기\n\n- 6000자 분량의 상세 요구사항\n' + '세부 '.repeat(2000);
  assert.equal(goalTitle(goal), '달빛 판타지 수집형 RPG 만들기');
  assert.equal(goalTitle('/goal: 달빛 습관 앱'), '달빛 습관 앱');
  assert.equal(goalTitle('---\n> [링크 앱](https://x.invalid) 만들기'), '링크 앱 만들기');
  assert.equal(goalTitle('가'.repeat(500)).length, 160);
  assert.equal(goalTitle('  \n/goal\n'), '이름 없는 앱 흐름');
  assert.equal(goal.startsWith('/goal'), true, 'the stored goal is not modified');
});

test('a second rejection restarts the return animation only for a new report nonce', () => {
  const run = fresh();
  const stage = node(run, 'research');
  stage.status = 'review';
  stage.active = { phase: 'review', nonce: 'second' };
  stage.feedback = { phase: 'review', nonce: 'first', summary: '첫 번째 수정 요청' };
  const before = snapshotStates(run);
  stage.active = null;
  stage.status = 'pending';
  stage.feedback = { phase: 'review', nonce: 'second', summary: '두 번째 수정 요청' };
  assert.equal(transitions(before, run).get(stage.id), 'retry');
  assert.equal(transitions(snapshotStates(run), run).size, 0);
});

test('the stage view carries the current job\'s time budget', () => {
  let run = fresh();
  run = claimNode(run, 'research', { nonce: 'n1', now: NOW });
  run.jobs = [{ nonce: 'n1', nodeId: 'research', state: 'running', budgetMinutes: 15 }];
  assert.equal(stageView(run, node(run, 'research')).budgetMinutes, 15);
  assert.equal(stageView(run, node(run, 'brief')).budgetMinutes, null);
});
