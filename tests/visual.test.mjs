import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeModel, normalizeEffort, launchSettings, applyModelToCommand, createLaunchOverrides,
  loadSkillCatalog, skillDirsFor, detectArtDirection, selectVisualSkills, visualInstruction, createVisualAdvisor,
  VISUAL_DEFAULT, EFFORTS,
} from '../src/visual.mjs';

function memoryIo(tree) {
  return {
    readdir: async (dir) => { if (!Array.isArray(tree[dir])) throw Object.assign(new Error('ENOENT ' + dir), { code: 'ENOENT' }); return [...tree[dir]]; },
    readHead: async (file, bytes) => { if (typeof tree[file] !== 'string') throw Object.assign(new Error('ENOENT ' + file), { code: 'ENOENT' }); return tree[file].slice(0, bytes); }
  };
}
const skill = (name, description = name + ' skill') => '---\nname: ' + name + '\ndescription: ' + description + '\n---\n';
const HOME = '/home/u';
const skillTree = (dir, names) => Object.fromEntries([[dir, names], ...names.map((name) => [dir + '/' + name + '/SKILL.md', skill(name)])]);
const codexTree = { ...skillTree(HOME + '/.codex/skills', ['sprite-gen', 'pixel-art-studio', 'pixel-art-style', 'pixelfx', 'picxel']), ...skillTree(HOME + '/.agents/skills', ['image', 'imagegen-frontend-mobile']) };
const names = (list) => list.map((item) => item.name);

test('model ids and efforts are validated; empty clears', () => {
  assert.equal(normalizeModel('gpt-6.2-sol'), 'gpt-6.2-sol');
  assert.equal(normalizeModel(''), undefined);
  for (const bad of ['gpt 6', 'x;rm', '-m', 'a'.repeat(80), 'model$(id)']) assert.throws(() => normalizeModel(bad), /모델/, bad);
  assert.deepEqual(EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(normalizeEffort('high'), 'high');
  assert.equal(normalizeEffort(''), undefined);
  assert.throws(() => normalizeEffort('extreme'), /추론/);
});

test('design and assets default to gpt-6.2-sol high on codex; explicit fields win; other stages use the agent default', () => {
  assert.deepEqual(VISUAL_DEFAULT, { model: 'gpt-6.2-sol', effort: 'high' });
  assert.deepEqual(launchSettings({ id: 'design' }, 'codex'), { model: 'gpt-6.2-sol', effort: 'high', source: 'default' });
  assert.deepEqual(launchSettings({ id: 'assets', model: 'gpt-6.1-terra' }, 'codex'), { model: 'gpt-6.1-terra', effort: 'high', source: 'stage' });
  assert.equal(launchSettings({ id: 'design' }, 'claude'), null);
  assert.equal(launchSettings({ id: 'build' }, 'codex'), null);
  assert.deepEqual(launchSettings({ id: 'build', model: 'claude-opus-5-5', effort: 'max' }, 'claude'), { model: 'claude-opus-5-5', effort: 'max', source: 'stage' });
});

test('the agent command gets model flags right after the agent binary, or is left alone with a reason', () => {
  const codex = { model: 'gpt-6.2-sol', effort: 'high' };
  assert.deepEqual(applyModelToCommand('codex', 'codex', codex), { command: 'codex -m gpt-6.2-sol -c model_reasoning_effort=high' });
  assert.deepEqual(applyModelToCommand("'/opt/bin/codex' --yolo", 'codex', codex), { command: "'/opt/bin/codex' -m gpt-6.2-sol -c model_reasoning_effort=high --yolo" });
  assert.deepEqual(applyModelToCommand("claude --plugin-dir '/a b/x' --dangerously-skip-permissions", 'claude', { model: 'claude-opus-5-5', effort: 'high' }),
    { command: "claude --model claude-opus-5-5 --effort high --plugin-dir '/a b/x' --dangerously-skip-permissions" });
  assert.match(applyModelToCommand('codex -m other', 'codex', codex).reason, /이미/);
  assert.match(applyModelToCommand('codex --model=other', 'codex', codex).reason, /이미/);
  assert.match(applyModelToCommand('node run.js', 'codex', codex).reason, /찾지 못/);
  assert.match(applyModelToCommand('codex && codex', 'codex', codex).reason, /찾지 못/);
  assert.match(applyModelToCommand('gemini', 'gemini', codex).reason, /지원/);
});

test('a launch override is consumed once by the matching hook event and reports whether it applied', () => {
  let clock = 0;
  const overrides = createLaunchOverrides({ now: () => clock });
  const next = (event) => ({ continued: event });
  const pending = overrides.expect({ workspaceId: 'w1', agent: 'codex', settings: { model: 'gpt-6.2-sol', effort: 'high' } });
  assert.equal(overrides.handle({ agent: 'claude', workspaceId: 'w1', command: 'claude', env: {} }, next), undefined, 'other agents pass');
  const result = overrides.handle({ agent: 'codex', workspaceId: 'w1', command: 'codex', env: {} }, next);
  assert.equal(result.continued.command, 'codex -m gpt-6.2-sol -c model_reasoning_effort=high');
  assert.deepEqual(pending.result(), { applied: true, model: 'gpt-6.2-sol', effort: 'high' });
  assert.equal(overrides.handle({ agent: 'codex', workspaceId: 'w1', command: 'codex', env: {} }, next), undefined, 'consumed once');
  const missed = overrides.expect({ workspaceId: 'w1', agent: 'codex', settings: { model: 'gpt-6.2-sol' } });
  clock = 60_000;
  assert.equal(overrides.handle({ agent: 'codex', workspaceId: 'w1', command: 'codex', env: {} }, next), undefined, 'expired');
  assert.equal(missed.result().applied, false);
  assert.match(missed.result().reason, /hook/);
  const refused = overrides.expect({ workspaceId: 'w1', agent: 'codex', settings: { model: 'm1' } });
  overrides.handle({ agent: 'codex', workspaceId: 'w1', command: 'codex -m x', env: {} }, next);
  assert.match(refused.result().reason, /이미/);
});

test('skills are read from the folders the stage agent loads, with safe names only', async () => {
  assert.deepEqual(skillDirsFor('codex', HOME), [HOME + '/.codex/skills', HOME + '/.agents/skills']);
  assert.deepEqual(skillDirsFor('claude', HOME), [HOME + '/.claude/skills']);
  assert.deepEqual(skillDirsFor('gemini', HOME), []);
  const tree = { ...codexTree, [HOME + '/.codex/skills']: [...codexTree[HOME + '/.codex/skills'], 'Bad Name', 'broken'] };
  tree[HOME + '/.codex/skills/broken/SKILL.md'] = 'no frontmatter';
  const catalog = await loadSkillCatalog({ dirs: skillDirsFor('codex', HOME), io: memoryIo(tree) });
  assert.deepEqual(names(catalog.skills).sort(), ['image', 'imagegen-frontend-mobile', 'picxel', 'pixel-art-studio', 'pixel-art-style', 'pixelfx', 'sprite-gen']);
  const none = await loadSkillCatalog({ dirs: ['/missing'], io: memoryIo({}) });
  assert.deepEqual(none.skills, []);
  assert.match(none.error, /스킬/);
});

test('pixel art is detected from the goal, earlier reports and the project; otherwise not', async () => {
  const run = (goal, extra = {}) => ({ goal, workspacePath: '/w', nodes: [], ...extra });
  const io = (tree = {}) => memoryIo({ '/w': [], ...tree });
  for (const goal of ['16-bit 레트로 액션', '도트 그래픽 RPG', 'a pixel art platformer', '픽셀 감성 게임', '8bit shooter']) {
    assert.equal((await detectArtDirection({ run: run(goal), io: io() })).pixel, true, goal);
  }
  assert.equal((await detectArtDirection({ run: run('세로형 군중 러너'), io: io() })).pixel, false);
  const fromReport = run('러너 게임', { nodes: [{ id: 'brief', report: { summary: '아트 방향: 32x32 픽셀 스프라이트' } }] });
  assert.equal((await detectArtDirection({ run: fromReport, io: io() })).source, 'report');
  const godot = await detectArtDirection({ run: run('게임'), io: io({ '/w': ['project.godot'], '/w/project.godot': '[rendering]\ntextures/canvas_textures/default_texture_filter=0\n' }) });
  assert.deepEqual([godot.pixel, godot.source], [true, 'project']);
  const aseprite = await detectArtDirection({ run: run('게임'), io: io({ '/w': ['assets'], '/w/assets': ['hero.aseprite'] }) });
  assert.equal(aseprite.pixel, true);
});

test('the skill shortlist follows stage and art direction and only names installed skills', async () => {
  const catalog = await loadSkillCatalog({ dirs: skillDirsFor('codex', HOME), io: memoryIo(codexTree) });
  const pixelAssets = selectVisualSkills({ catalog, stage: 'assets', pixel: true, agent: 'codex' });
  assert.deepEqual(names(pixelAssets).slice(0, 2), ['pixel-art-studio', 'sprite-gen']);
  for (const name of ['pixelfx', 'picxel']) assert.ok(names(pixelAssets).includes(name), name);
  assert.ok(pixelAssets.every((item) => item.why));
  const plainAssets = selectVisualSkills({ catalog, stage: 'assets', pixel: false, agent: 'codex' });
  assert.equal(plainAssets[0].name, 'sprite-gen');
  assert.ok(names(plainAssets).includes('codex image_gen'), 'codex has a built-in image tool');
  assert.ok(!names(plainAssets).includes('pixel-art-studio'));
  const design = selectVisualSkills({ catalog, stage: 'design', pixel: false, agent: 'codex' });
  assert.equal(design[0].name, 'imagegen-frontend-mobile');
  const claudeCatalog = await loadSkillCatalog({ dirs: skillDirsFor('claude', HOME), io: memoryIo(skillTree(HOME + '/.claude/skills', ['sprite-gen'])) });
  assert.deepEqual(names(selectVisualSkills({ catalog: claudeCatalog, stage: 'assets', pixel: true, agent: 'claude' })), ['sprite-gen']);
  assert.deepEqual(selectVisualSkills({ catalog, stage: 'build', pixel: true, agent: 'codex' }), []);
});

test('the brief demands real image files in the right place, lists the skills as data and says when to report blocked', () => {
  const visual = { stage: 'assets', art: { pixel: true, source: 'goal' }, skills: [{ name: 'pixel-art-studio', why: '타일셋·캐릭터', description: 'Creates pixel art.' }] };
  const text = visualInstruction({ phase: 'work', visual });
  for (const part of ['pixel-art-studio', '참고 자료', '실제 이미지 파일', '커밋', 'artifact', 'blocked', '임시 도형', '픽셀']) assert.ok(text.includes(part), part);
  const design = visualInstruction({ phase: 'work', visual: { ...visual, stage: 'design', art: { pixel: false } } });
  assert.match(design, /결과 디렉터리/);
  assert.doesNotMatch(design, /커밋/);
  assert.equal(visualInstruction({ phase: 'review', visual }), '');
  assert.equal(visualInstruction({ phase: 'work' }), '');
});

test('the advisor combines skills, art direction and launch settings and never throws', async () => {
  const advisor = createVisualAdvisor({ home: HOME, io: memoryIo({ ...codexTree, '/w': [] }) });
  const record = await advisor.advise({ run: { goal: '도트 RPG', workspacePath: '/w', nodes: [] }, node: { id: 'assets' }, job: { phase: 'work', agent: 'codex' } });
  assert.equal(record.art.pixel, true);
  assert.equal(record.skills[0].name, 'pixel-art-studio');
  assert.deepEqual(record.launch, { model: 'gpt-6.2-sol', effort: 'high', source: 'default' });
  assert.equal(await advisor.advise({ run: { goal: '', nodes: [] }, node: { id: 'build' }, job: { phase: 'work', agent: 'codex' } }), null);
  const broken = createVisualAdvisor({ home: HOME, io: { readdir: async () => { throw new Error('boom'); }, readHead: async () => '' } });
  const fallback = await broken.advise({ run: { goal: '', workspacePath: '/w', nodes: [] }, node: { id: 'design' }, job: { phase: 'work', agent: 'codex' } });
  assert.match(fallback.error, /boom|스킬/);
});

test('the hook matches Orca\'s internal worktree id (<repo-id>::<path>) to the plugin\'s identity id and logs every call', () => {
  const lines = [];
  const overrides = createLaunchOverrides({ log: (line) => lines.push(line) });
  const next = (event) => event;
  const pending = overrides.expect({ workspaceId: 'identity:wt2:local:dc84a59d', workspacePath: '/Users/t/orca/workspaces/app/neon-4f26', agent: 'codex', settings: { model: 'gpt-6.2-sol', effort: 'high' } });
  overrides.handle({ agent: 'codex', workspaceId: 'f466a314::/Users/t/other', command: 'codex', env: {} }, next);
  const applied = overrides.handle({ agent: 'codex', workspaceId: 'f466a314::/Users/t/orca/workspaces/app/neon-4f26', command: 'codex', env: {} }, next);
  assert.equal(applied.command, 'codex -m gpt-6.2-sol -c model_reasoning_effort=high');
  assert.equal(pending.result().applied, true);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /codex.*f466a314::\/Users\/t\/other.*일치하는 대기 실행 없음/);
  assert.match(lines[1], /적용.*-m gpt-6\.2-sol/);
});

test('a launch whose hook saw only other workspaces reports the ids it saw', () => {
  const overrides = createLaunchOverrides({ log: () => {} });
  const pending = overrides.expect({ workspaceId: 'identity:wt2:local:x', workspacePath: '/w/a', agent: 'codex', settings: { model: 'm1' } });
  overrides.handle({ agent: 'codex', workspaceId: 'r::/w/b', command: 'codex', env: {} }, (event) => event);
  const result = pending.result();
  assert.equal(result.applied, false);
  assert.match(result.reason, /작업 공간이 일치하지 않/);
  assert.match(result.reason, /r::\/w\/b/);
});
