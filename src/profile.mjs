/**
 * Speed and cost profile of a run: which agent and model works and reviews each stage, and how
 * far the build stage fans out to subagents. One table; a stage's own model or effort (set on the
 * run card) wins field by field for its work phase. Runs from before profiles keep the old rule:
 * only a Codex design or assets stage gets the visual default (src/visual.mjs).
 */
import { launchSettings, VISUAL_STAGES } from './visual.mjs';

export const PROFILES = Object.freeze(['fast', 'balanced', 'saver']);
export const DEFAULT_PROFILE = 'balanced';
export const PROFILE_NAMES = Object.freeze({ fast: '빠르게', balanced: '균형', saver: '절약' });
// Valid ids per agent family; normalizeModel's rules still apply to anything a person types.
const MODELS = {
  claude: { top: 'claude-opus-5-5', mid: 'claude-sonnet-5-5', low: 'claude-haiku-5-5' },
  codex: { top: 'gpt-6.2-sol', mid: 'gpt-6.2-sol', low: 'gpt-6.2-sol' },
};
const OTHER = { claude: 'codex', codex: 'claude' };
const FANOUT = { fast: 5, balanced: 3, saver: 0 }; // build subagents (src/fanout.mjs)
const IMAGE = new Set(VISUAL_STAGES); // Codex has the image tools
const HEAVY = new Set(['build', 'test']);
const DOCS = new Set(['research', 'brief', 'policy', 'listing']);
const fail = (message) => { throw Object.assign(new Error(message), { code: 'invalid_params' }); };

export function normalizeProfile(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!PROFILES.includes(value)) fail('프로필은 ' + PROFILES.join(', ') + ' 중 하나여야 합니다.');
  return value;
}

/** The plugin setting defaultProfile when valid, else balanced; unreadable settings keep balanced. */
export async function readDefaultProfile(settings) {
  return (await defaultProfileOf(settings)).profile;
}
/** { profile, warning? }: the warning says why a set default could not be used (shown on the run). */
export async function defaultProfileOf(settings) {
  let value;
  try { value = await settings?.get?.('defaultProfile'); }
  catch (error) { return { profile: DEFAULT_PROFILE, warning: '기본 프로필 설정을 읽지 못해 균형으로 만들었습니다: ' + String(error?.message ?? error).slice(0, 200) }; }
  if (value === undefined || value === null || value === '' || PROFILES.includes(value)) return { profile: PROFILES.includes(value) ? value : DEFAULT_PROFILE };
  return { profile: DEFAULT_PROFILE, warning: '기본 프로필 설정값 "' + String(value).slice(0, 40) + '"은(는) ' + PROFILES.join('·') + '이 아니어서 균형으로 만들었습니다.' };
}

const workAgent = (stage) => IMAGE.has(stage) ? 'codex' : 'claude';
const reviewAgent = (profile, stage) => profile === 'saver' ? 'claude' : OTHER[workAgent(stage)];

function workSpec(profile, node) {
  if (profile === 'fast' || IMAGE.has(node.id)) return { tier: 'top', effort: 'high' };
  if (node.id === 'build') return { tier: 'top', effort: profile === 'saver' ? 'medium' : 'high' };
  if (HEAVY.has(node.id)) return { tier: 'top', effort: 'high' };
  if (DOCS.has(node.id) || !node.write) return { tier: 'mid', effort: 'medium' };
  return { tier: 'top', effort: 'high' };
}
function reviewSpec(profile, node) {
  if (profile === 'fast') return { tier: 'top', effort: 'high' };
  if (profile === 'saver') return HEAVY.has(node.id) ? { tier: 'mid', effort: 'medium' } : { tier: 'low', effort: null };
  return { tier: 'mid', effort: HEAVY.has(node.id) ? 'high' : 'medium' };
}

/** Template stages without an agent get the profile's worker and (cross-family) reviewer. */
export function profileAssignments(nodes, profile, assignments = {}) {
  return nodes.map((node) => {
    const agent = node.agent ?? workAgent(node.id);
    const worker = assignments[node.id]?.agent ?? agent; // a person's worker choice keeps the review cross-family
    const reviewer = node.reviewer ?? (profile === 'saver' ? 'claude' : OTHER[worker] ?? reviewAgent(profile, node.id));
    return { ...node, agent, reviewer };
  });
}

/** { model, effort, source: 'stage' | 'profile' | 'default', profile? } for one launch, or null (the agent's own default). */
export function resolveLaunch(run, node, phase, agent) {
  if (!run.profile) return phase === 'work' ? launchSettings(node, agent) : null;
  const models = MODELS[agent];
  const spec = (phase === 'review' ? reviewSpec : workSpec)(run.profile, node);
  // A stage moved to another agent (src/fallback.mjs) keeps its effort but not a model id of the old agent's family.
  const model = phase === 'work' && !node.original?.agent ? node.model : undefined;
  const own = phase === 'work' && (model || node.effort);
  if (!models && !own) return null;
  return {
    model: model || (models ? models[spec.tier] : null),
    effort: (phase === 'work' && node.effort) || spec.effort,
    source: own ? 'stage' : 'profile', profile: run.profile,
  };
}

/** How many subagents the build stage may run in parallel (0 for runs from before profiles). */
export const fanoutOf = (run) => FANOUT[run.profile] ?? 0;

const WHY = { stage: () => '단계 지정', default: () => '시각 단계 기본값' };
function describe(run, node, phase) {
  const agent = phase === 'review' ? node.reviewer : node.agent;
  const settings = resolveLaunch(run, node, phase, agent);
  if (!settings) return { agent, model: null, effort: null, source: null, why: '에이전트 기본 설정' };
  const cross = phase === 'review' && OTHER[node.agent] === agent;
  const why = WHY[settings.source]?.() ?? '프로필 ' + PROFILE_NAMES[run.profile] + (cross ? ' · 교차 검토' : '');
  const moved = node.original?.[phase === 'review' ? 'reviewer' : 'agent']; // src/fallback.mjs
  return { agent, model: settings.model, effort: settings.effort, source: settings.source, why: why + (moved ? ' · ' + moved + ' 대신 대체 진행' : '') };
}

/** Per stage and phase: the agent, model and effort a launch would use now, and why. */
export function launchPlan(run) {
  return Object.fromEntries(run.nodes.map((node) => [node.id, { work: describe(run, node, 'work'), review: describe(run, node, 'review') }]));
}
