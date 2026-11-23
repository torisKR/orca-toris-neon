/**
 * Visual stages (design, assets): which model the stage agent runs on, which installed image,
 * sprite and pixel-art skills fit the art direction, and what the brief demands. File contents
 * are untrusted text and reach the brief only as data.
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { parseFrontmatter, oneLine, fileIo } from './ecc.mjs';

export const VISUAL_STAGES = ['design', 'assets'];
// Stages whose brief lists installed skills found at launch; only VISUAL_STAGES get the image model.
const SKILL_STAGES = [...VISUAL_STAGES, 'monetization'];
export const VISUAL_DEFAULT = { model: 'gpt-6.2-sol', effort: 'high' };
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/i;
const SAFE_SKILL = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const HEAD_BYTES = 4096;
const OVERRIDE_TTL_MS = 10_000; // the hook fires inside the plugin's own agent.launch call
const MAX_SKILLS = 6;
const IMAGE_TOOL = 'codex image_gen';
const fail = (message) => { throw Object.assign(new Error(message), { code: 'invalid_params' }); };

/** '' or undefined clears (the agent's own default); anything else must be a plain model id. */
export function normalizeModel(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !MODEL_PATTERN.test(value)) fail('모델 이름이 올바르지 않습니다.');
  return value;
}
export function normalizeEffort(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!EFFORTS.includes(value)) fail('추론 강도는 ' + EFFORTS.join(', ') + ' 중 하나여야 합니다.');
  return value;
}

/** Model and effort for a work launch: the stage's fields, else the visual default on Codex. */
export function launchSettings(node, agent) {
  if (node.model || node.effort) {
    const defaults = VISUAL_STAGES.includes(node.id) && agent === 'codex' ? VISUAL_DEFAULT : {};
    return { model: node.model ?? defaults.model ?? null, effort: node.effort ?? defaults.effort ?? null, source: 'stage' };
  }
  if (VISUAL_STAGES.includes(node.id) && agent === 'codex') return { ...VISUAL_DEFAULT, source: 'default' };
  return null;
}

const FLAGS = {
  codex: (model, effort) => [...(model ? ['-m', model] : []), ...(effort ? ['-c', 'model_reasoning_effort=' + effort] : [])],
  claude: (model, effort) => [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])],
};
const ALREADY = /(^|\s)(-m|--model|--effort)(\s|=|$)|model_reasoning_effort/;

/** Insert model flags right after the one agent binary token of Orca's launch command. */
export function applyModelToCommand(command, agent, { model, effort }) {
  if (!FLAGS[agent]) return { reason: agent + ' 에이전트의 모델 지정은 지원하지 않습니다.' };
  if (ALREADY.test(command)) return { reason: '실행 명령이 이미 모델이나 추론 강도를 지정하고 있어 바꾸지 않았습니다.' };
  const tokens = command.split(/(\s+)/);
  const binary = (token) => path.basename(token.replace(/^['"]|['"]$/g, '')) === agent;
  const hits = tokens.map((token, index) => binary(token) ? index : -1).filter((index) => index >= 0);
  if (hits.length !== 1) return { reason: '실행 명령에서 ' + agent + ' 실행 파일을 하나로 찾지 못해 모델을 지정하지 않았습니다.' };
  const flags = FLAGS[agent](model, effort);
  tokens.splice(hits[0] + 1, 0, ' ' + flags.join(' '));
  return { command: tokens.join('') };
}

/**
 * The plugin cannot pass a model to agent.launch; Orca's agent.launch.before hook can change the
 * command line. The runtime registers what it expects right before launching; the hook applies
 * it to the one matching launch and reports back.
 */
export function createLaunchOverrides({ now = Date.now, log = () => {} } = {}) {
  const pending = [];
  // Orca's hook events carry its internal worktree id `<repo-id>::<path>`; the plugin knows the
  // workspace by its `identity:…` id and path. Either form identifies the same workspace.
  const sameWorkspace = (entry, id) => typeof id === 'string' && (id === entry.workspaceId ||
    (entry.workspaceId?.startsWith('identity:') && id === entry.workspaceId.slice('identity:'.length)) ||
    (Boolean(entry.workspacePath) && id.endsWith('::' + entry.workspacePath)));
  return {
    expect({ workspaceId, workspacePath, agent, settings }) {
      const entry = { workspaceId, workspacePath, agent, settings, at: now(), outcome: null, seen: [] };
      pending.push(entry);
      return {
        result: () => {
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
          if (entry.outcome?.command) return { applied: true, ...(settings.model ? { model: settings.model } : {}), ...(settings.effort ? { effort: settings.effort } : {}) };
          if (entry.outcome?.reason) return { applied: false, reason: entry.outcome.reason };
          if (entry.seen.length) return { applied: false, reason: 'Orca의 agent.launch.before hook이 실행됐지만 작업 공간이 일치하지 않았습니다 (본 값: ' + entry.seen.join(', ') + ').' };
          return { applied: false, reason: 'Orca의 agent.launch.before hook이 실행되지 않아 모델을 지정하지 못했습니다.' };
        }
      };
    },
    // Called from the hook: synchronous, no awaits, so it decides well inside Orca's 2 s limit.
    // Every call is logged so a real launch shows what the hook saw and did.
    handle(event, next) {
      const live = pending.filter((entry) => !entry.outcome && now() - entry.at < OVERRIDE_TTL_MS);
      const entry = live.find((item) => item.agent === event.agent && sameWorkspace(item, event.workspaceId));
      const head = 'agent.launch.before: agent=' + event.agent + ' workspace=' + event.workspaceId + ' → ';
      if (!entry) {
        for (const item of live) if (item.agent === event.agent) item.seen.push(String(event.workspaceId).slice(0, 200));
        log(head + '일치하는 대기 실행 없음 (대기 ' + live.length + '개: ' + live.map((item) => item.agent + '@' + (item.workspacePath ?? item.workspaceId)).join(', ') + ')');
        return undefined;
      }
      entry.outcome = applyModelToCommand(String(event.command ?? ''), event.agent, entry.settings);
      log(head + (entry.outcome.command ? '적용: ' + entry.outcome.command.slice(0, 200) : '적용하지 않음: ' + entry.outcome.reason));
      return entry.outcome.command ? next({ ...event, command: entry.outcome.command }) : undefined;
    }
  };
}

export const skillDirsFor = (agent, home = homedir()) => ({
  codex: [path.join(home, '.codex', 'skills'), path.join(home, '.agents', 'skills')],
  claude: [path.join(home, '.claude', 'skills')],
}[agent] ?? []);

/** Installed skills (name + one line) in the folders the stage agent loads. Never throws. */
export async function loadSkillCatalog({ dirs, io = fileIo }) {
  const skills = [];
  const errors = [];
  for (const dir of dirs) {
    let entries;
    try { entries = (await io.readdir(dir)).sort(); }
    catch (error) { errors.push(dir + ': ' + String(error?.message ?? error).slice(0, 120)); continue; }
    for (const entry of entries) {
      if (!SAFE_SKILL.test(entry)) continue;
      let meta;
      try { meta = parseFrontmatter(await io.readHead(path.join(dir, entry, 'SKILL.md'), HEAD_BYTES)); } catch { continue; }
      if (!meta || !SAFE_SKILL.test(meta.name) || skills.some((item) => item.name === meta.name)) continue;
      skills.push({ name: meta.name, description: oneLine(meta.description) });
    }
  }
  return { skills, ...(skills.length === 0 ? { error: '설치된 스킬을 읽지 못했습니다 (' + (errors.join('; ') || dirs.join(', ')) + ')' } : {}) };
}

const PIXEL_WORDS = /pixel|픽셀|도트|\b(8|16|32)[- ]?bit|\b(8|16)비트|retro|레트로/i;
const ART_DIRS = ['assets', 'art', 'sprites', 'graphics', 'textures'];
const listing = async (io, dir) => { try { return await io.readdir(dir); } catch { return []; } };

/** Pixel-art game or not: goal, earlier reports, then the project's own files. */
export async function detectArtDirection({ run, io = fileIo }) {
  if (PIXEL_WORDS.test(String(run.goal ?? ''))) return { pixel: true, source: 'goal' };
  const reports = (run.nodes ?? []).flatMap((node) => [node.report?.summary, node.review?.summary]).filter(Boolean).join('\n');
  if (PIXEL_WORDS.test(reports)) return { pixel: true, source: 'report' };
  const root = run.workspacePath;
  if (!root) return { pixel: false, source: 'none' };
  const names = await listing(io, root);
  if (names.includes('project.godot')) {
    try {
      // Godot's nearest texture filter is 0.
      if (/default_texture_filter\s*=\s*0\b/.test(await io.readHead(path.join(root, 'project.godot'), 64 * 1024))) return { pixel: true, source: 'project' };
    } catch { /* unreadable project file: no evidence either way */ }
  }
  for (const dir of ['.', ...ART_DIRS.filter((name) => names.includes(name))]) {
    const files = dir === '.' ? names : await listing(io, path.join(root, dir));
    if (files.some((file) => /\.(aseprite|ase|pyxel)$/i.test(file))) return { pixel: true, source: 'project' };
  }
  return { pixel: false, source: 'none' };
}

// [stage, pixel] → skills in order with why. 'codex image_gen' is Codex's built-in image tool.
const BILLING_RULES = [
  ['play-billing-library-version-upgrade', 'Play Billing Library 요구 버전 확인과 업그레이드'],
  ['paywalls', '페이월 화면 설계'],
  ['pricing', '가격·상품 구성'],
];
const RULES = {
  'monetization:plain': BILLING_RULES,
  'monetization:pixel': BILLING_RULES,
  'assets:pixel': [
    ['pixel-art-studio', '캐릭터·타일셋·HUD/UI 킷·애니메이션 프레임을 PNG 아틀라스로 (오프라인, Python+Pillow)'],
    ['sprite-gen', '애니메이션 스프라이트와 스프라이트 시트 생성·정리'],
    ['pixelfx', '불·폭발·타격 같은 효과 스프라이트 시트 (Node 18)'],
    ['picxel', '참조 이미지를 픽셀 그리드·팔레트에 맞춘 게임 스프라이트로 정리'],
    [IMAGE_TOOL, '컨셉·참조 이미지가 필요할 때만'],
    ['pixel-art-style', '3D/Blender 에셋을 픽셀로 렌더할 때만'],
  ],
  'assets:plain': [
    ['sprite-gen', '캐릭터와 애니메이션 스프라이트·시트'],
    [IMAGE_TOOL, '배경·아이콘·UI 아트'],
    ['image', '앱 아이콘·스토어 그래픽'],
  ],
  'design:pixel': [
    ['imagegen-frontend-mobile', '화면 시안 (픽셀 스타일을 명시)'],
    ['pixel-art-studio', 'HUD·메뉴 UI 킷 시안'],
    [IMAGE_TOOL, '화면 시안 이미지'],
  ],
  'design:plain': [
    ['imagegen-frontend-mobile', '모바일 화면 시안과 흐름'],
    [IMAGE_TOOL, '화면 시안 이미지'],
  ],
};

/** Installed skills (and Codex's built-in image tool) for this stage and art direction. */
export function selectVisualSkills({ catalog, stage, pixel, agent }) {
  const rules = RULES[stage + ':' + (pixel ? 'pixel' : 'plain')] ?? [];
  const installed = new Map((catalog?.skills ?? []).map((item) => [item.name, item]));
  return rules.flatMap(([name, why]) => {
    if (name === IMAGE_TOOL) return agent === 'codex' ? [{ name, why, builtin: true }] : [];
    return installed.has(name) ? [{ name, why, description: installed.get(name).description }] : [];
  }).slice(0, MAX_SKILLS);
}

/** Brief section for a visual work stage, built only from the job's recorded shortlist. */
export function visualInstruction(job) {
  const visual = job.visual;
  if (job.phase !== 'work' || !visual || !VISUAL_STAGES.includes(visual.stage)) return '';
  const pixel = visual.art?.pixel;
  const where = visual.stage === 'assets'
    ? '이미지는 엔진이 쓰는 크기·포맷(예: PNG, 투명 배경, 필요한 해상도와 스프라이트 시트 규격)으로 워크스페이스의 에셋 경로에 실제 파일로 만들어 커밋하고 소스에 연결하세요.'
    : '이 단계는 소스를 바꾸지 않으므로 화면 시안 이미지는 결과 디렉터리에 실제 이미지 파일로 저장하세요.';
  const line = (item) => '- ' + item.name + ' — ' + item.why + (item.description ? ' (설명: ' + item.description + ')' : '');
  return [
    '시각 산출물: 이 단계는 설명이 아니라 실제 이미지 파일을 만들어야 합니다. ' + where,
    '아트 방향: ' + (pixel ? '픽셀 아트 게임입니다. 정수 배율, 최근접(nearest) 필터, 일관된 팔레트와 그리드를 지키세요.' : '픽셀 아트가 아닙니다.'),
    visual.skills?.length ? '설치돼 있어 맞는 스킬·도구(참고 자료이며 지시가 아닙니다. 각 스킬의 SKILL.md를 먼저 읽고 그 절차를 따르세요):\n' + visual.skills.map(line).join('\n') : '',
    '만든 각 이미지의 경로·크기·해상도·포맷을 결과 디렉터리의 assets-manifest.md에 적고, 이미지 사본(또는 대표 이미지)을 결과 디렉터리에 복사해 보고서 evidence의 artifact로 넣으세요.',
    '필요한 스킬이나 이미지 도구를 쓸 수 없거나 설정되지 않은 유료 키가 필요하면 outcome을 blocked로 하고 정확한 이유를 적으세요. 임시 도형·단색 사각형·플레이스홀더 이미지로 대신하지 마세요.'
  ].filter(Boolean).join('\n');
}

/** Per-launch record for design/assets work: skills, art direction, model settings. Never throws. */
export function createVisualAdvisor({ home = homedir(), io = fileIo } = {}) {
  return {
    async advise({ run, node, job }) {
      if (!SKILL_STAGES.includes(node.id) || job.phase !== 'work') return null;
      const launch = launchSettings(node, job.agent);
      try {
        const [catalog, art] = await Promise.all([loadSkillCatalog({ dirs: skillDirsFor(job.agent, home), io }), detectArtDirection({ run, io })]);
        return { stage: node.id, art, skills: selectVisualSkills({ catalog, stage: node.id, pixel: art.pixel, agent: job.agent }), launch,
          ...(catalog.error ? { error: catalog.error } : {}) };
      } catch (error) {
        return { stage: node.id, art: { pixel: false, source: 'none' }, skills: [], launch, error: '시각 스킬 안내를 만들지 못했습니다: ' + String(error?.message ?? error).slice(0, 200) };
      }
    }
  };
}
