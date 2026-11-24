/**
 * Remote control contract for bots and other callers (plan section 10): create, inspect, resume and
 * follow up runs through Neon's own handlers. A caller's requestId identifies one request: the same
 * requestId with the same content returns the run it already made (a cancelled one too, so a
 * redelivered message never restarts work), the same requestId with different content is a
 * conflict, and the goal text alone never dedupes. The content fingerprint rides in the runs.create
 * requestId key, so it survives restarts and archiving without a store of its own. Requests are
 * handled one at a time so two deliveries cannot both create.
 * Reached as the command `neon.remote` (args) and the panel handler `remote.request` (input);
 * docs/ROADMAP.md lists which Orca 1.4.271 paths reach which.
 */
import { createHash } from 'node:crypto';
import { milestones, milestoneText } from './milestones.mjs';

const REQUEST_ID = /^[\w.:-]{1,70}$/; // + 'remote.' + '.' + 16 hex stays within runs.create's 100
const REMOTE_PREFIX = 'remote.', KEY_PREFIX = 'req:' + REMOTE_PREFIX; // runs.create adds 'req:'
const MODES = new Set(['new-app', 'improve', 'diagnose']);
const FIELDS = {
  create: ['action', 'requestId', 'mode', 'projectId', 'goal', 'kind'],
  followUp: ['action', 'requestId', 'parentRunId', 'kind', 'goal'],
  get: ['action', 'requestId', 'runId'],
  resume: ['action', 'requestId', 'runId', 'expectedRevision']
};

export const REMOTE_HELP = [
  'Toris Neon 원격 제어 (neon.remote 명령의 args 또는 remote.request 핸들러의 input):',
  '- { action: "create", requestId, mode: "new-app"|"improve"|"diagnose", projectId, goal, kind? } 실행 계획 만들기(시작하지 않음)',
  '- { action: "followUp", requestId, parentRunId, kind, goal } 이전 실행에서 이어지는 개선 만들기',
  '- { action: "get", requestId | runId } 상태와 실제로 끝난 것(구현·검증·제출)',
  '- { action: "resume", requestId | runId, expectedRevision? } 시작하지 않은 실행은 시작, 멈춘 실행은 재개',
  '같은 requestId와 같은 내용은 기존 실행을, 다른 내용은 충돌을 돌려줍니다. 목표 문장만으로는 같은 요청으로 보지 않습니다.',
  '명령 팔레트에서 인자 없이 실행하면 이 안내만 보여 줍니다.'
].join('\n');

// Orca's bridges keep only codes they know (conflict yes, not_found becomes action_failed), so the message leads with the code.
const fail = (code, message) => Object.assign(new Error('[' + code + '] ' + message), { code });
const invalid = (message) => fail('invalid_params', message);
const optionalText = (value, label, max) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) throw invalid(label + '은(는) ' + max + '자 이하의 문자열이어야 합니다.');
  return value.trim() || null;
};
const requiredText = (value, label, max) => optionalText(value, label, max) ?? (() => { throw invalid(label + ' 값이 필요합니다.'); })();

function onlyKnown(input, action) {
  const extra = Object.keys(input).filter((key) => !FIELDS[action].includes(key));
  if (extra.length) throw invalid(action + ' 요청에 알 수 없는 항목이 있습니다: ' + extra.join(', '));
}
function requestIdOf(value) {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw invalid('requestId는 70자 이하의 영문·숫자·_.:- 문자열이어야 합니다.');
  return value;
}

/** The caller's requestId and content fingerprint a run was created under, or null. */
function parseKey(key) {
  if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX)) return null;
  const rest = key.slice(KEY_PREFIX.length), dot = rest.lastIndexOf('.');
  const fingerprint = rest.slice(dot + 1);
  return dot > 0 && /^[0-9a-f]{16}$/.test(fingerprint) ? { requestId: rest.slice(0, dot), fingerprint } : null;
}
const fingerprintOf = (content) => createHash('sha256').update(JSON.stringify([content.mode, content.projectId, content.goal, content.kind, content.parentRunId])).digest('hex').slice(0, 16);
const findByRequest = (runs, requestId) => runs.find((run) => parseKey(run.requestId)?.requestId === requestId) ?? null;

/** What a caller sees of a run: never the internal key, always what actually finished. */
export function remoteSummary(run) {
  const nodes = run.nodes ?? [];
  return {
    runId: run.id, requestId: parseKey(run.requestId)?.requestId ?? null, status: run.status, started: Boolean(run.started),
    template: run.template ?? 'new-app', kind: run.improvement?.kind ?? null, parentRunId: run.parentRunId ?? null, projectId: run.projectId ?? null,
    goal: String(run.goal ?? '').slice(0, 200), revision: run.updatedAt ?? null, ...(run.pruned ? { pruned: true } : {}), // pruned: only its request key is left (src/requests.mjs)
    stages: { passed: nodes.filter((node) => node.status === 'passed').length, total: nodes.length },
    finished: milestones(run), finishedText: milestoneText(run)
  };
}

/** createRun is runs.create; startRun is the panel's runs.start (with preflight); resumeRun is runs.resume. */
export function createRemoteControl({ getRuns, createRun, startRun, resumeRun }) {
  let tail = Promise.resolve();
  const serial = (work) => { const next = tail.then(work, work); tail = next.catch(() => {}); return next; };

  const contentOf = (input, action, existing) => {
    if (action === 'followUp') {
      const parentRunId = requiredText(input.parentRunId, '이전 실행(parentRunId)', 160);
      // A redelivery still answers after the parent was pruned from the archives: the follow-up kept its project.
      const projectId = getRuns().find((run) => run.id === parentRunId)?.projectId ?? (existing?.parentRunId === parentRunId ? existing.projectId : undefined);
      if (projectId === undefined) throw invalid('이어서 개선할 이전 실행을 찾을 수 없습니다: ' + parentRunId);
      return { mode: 'improve', projectId, goal: requiredText(input.goal, '개선 목표', 6000), kind: requiredText(input.kind, '개선 종류(kind)', 40), parentRunId };
    }
    if (!MODES.has(input.mode)) throw invalid('mode는 new-app, improve, diagnose 중 하나여야 합니다.');
    const kind = optionalText(input.kind, '개선 종류(kind)', 40);
    if (input.mode === 'improve' && !kind) throw invalid('기존 앱 개선(improve)에는 개선 종류(kind)가 필요합니다.');
    if (input.mode !== 'improve' && kind) throw invalid('개선 종류(kind)는 improve에서만 받습니다.');
    const goal = input.mode === 'diagnose' ? optionalText(input.goal, '진단 메모', 6000) : requiredText(input.goal, '목표', 6000);
    return { mode: input.mode, projectId: requiredText(input.projectId, '프로젝트(projectId)', 256), goal, kind, parentRunId: null };
  };

  const create = async (input, action) => {
    const requestId = requestIdOf(input.requestId);
    const existing = findByRequest(getRuns(), requestId);
    const content = contentOf(input, action, existing), fingerprint = fingerprintOf(content);
    if (existing) {
      if (parseKey(existing.requestId).fingerprint !== fingerprint) {
        throw fail('conflict', 'requestId ' + requestId + '는 다른 내용으로 이미 실행 ' + existing.id + '을(를) 만들었습니다. 새 요청이면 새 requestId를 쓰세요.');
      }
      return { created: false, run: remoteSummary(existing) };
    }
    const run = await createRun({ template: content.mode, projectId: content.projectId, requestId: REMOTE_PREFIX + requestId + '.' + fingerprint,
      ...(content.goal ? { goal: content.goal } : {}), ...(content.kind ? { kind: content.kind } : {}), ...(content.parentRunId ? { parentRunId: content.parentRunId } : {}) });
    return { created: true, run: remoteSummary(run) };
  };

  const target = (input) => {
    if ((input.runId === undefined) === (input.requestId === undefined)) throw invalid('requestId와 runId 중 하나만 주세요.');
    const run = input.runId !== undefined
      ? getRuns().find((item) => item.id === input.runId)
      : findByRequest(getRuns(), requestIdOf(input.requestId));
    if (!run) throw fail('not_found', '해당 실행을 찾을 수 없습니다.');
    return run;
  };

  const resume = async (input) => {
    const run = target(input);
    if (input.expectedRevision !== undefined && typeof input.expectedRevision !== 'string') throw invalid('expectedRevision은 get이 돌려준 revision 문자열이어야 합니다.');
    if (['completed', 'cancelled'].includes(run.status)) throw fail('conflict', '실행 ' + run.id + '은(는) 이미 ' + run.status + ' 상태라 재개하지 않습니다.');
    // An early answer; the runtime compares again inside its queue, where nothing can change the run in between.
    if (input.expectedRevision !== undefined && input.expectedRevision !== run.updatedAt) {
      throw fail('conflict', '실행 ' + run.id + '이(가) 요청 이후 바뀌었습니다(현재 revision ' + run.updatedAt + '). 상태를 다시 확인한 뒤 요청하세요.');
    }
    const revision = input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision };
    const next = run.started ? await resumeRun({ runId: run.id, ...revision }) : await startRun({ runId: run.id, ...revision });
    return { action: run.started ? 'resumed' : 'started', run: remoteSummary(next) };
  };

  const ACTIONS = { create: (input) => create(input, 'create'), followUp: (input) => create(input, 'followUp'), get: async (input) => ({ run: remoteSummary(target(input)) }), resume };
  return {
    /** One remote request; no input (or {}) returns the help text. */
    request(input) {
      if (input === undefined || input === null) return Promise.resolve(REMOTE_HELP);
      if (typeof input !== 'object' || Array.isArray(input)) return Promise.reject(invalid('요청은 객체여야 합니다.'));
      if (!Object.keys(input).length) return Promise.resolve(REMOTE_HELP); // a panel bridge turns "no input" into {}
      if (!Object.hasOwn(ACTIONS, input.action)) return Promise.reject(invalid('action은 create, followUp, get, resume 중 하나여야 합니다.'));
      const run = async () => {
        onlyKnown(input, input.action);
        try { return await ACTIONS[input.action](input); }
        catch (error) { throw /^\[[a-z_]+\] /.test(String(error?.message)) ? error : fail(error?.code ?? 'action_failed', String(error?.message ?? error)); } // runtime errors too
      };
      return input.action === 'get' ? run() : serial(run); // a read never waits behind a slow start
    }
  };
}
