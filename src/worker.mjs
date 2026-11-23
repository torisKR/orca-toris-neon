import { fileURLToPath } from 'node:url';
import { readBuildInfo } from './buildinfo.mjs';
import { createRuntime } from './runtime.mjs';
import { createPlayService } from './play.mjs';
import { createTodayService } from './today.mjs';
import { createEccAdvisor } from './ecc.mjs';
import { createVisualAdvisor, createLaunchOverrides } from './visual.mjs';
import { createPreflight, preflightHandlers } from './preflight.mjs';

let activeRuntime;
const subscriptions = [];
const inputObject = (input) => {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('요청 입력은 객체여야 합니다.'), { code: 'invalid_params' });
  }
  return input;
};

/** Native Orca worker. All external actions stay behind Orca's granted host APIs. */
export default async function activate(orca) {
  const secrets = {
    get: async (key) => (await orca.host.call('secrets.get', { key })).value,
    set: (key, value) => orca.host.call('secrets.set', { key, value }),
    delete: (key) => orca.host.call('secrets.delete', { key }),
    protection: () => orca.host.call('secrets.protection', {})
  };
  const play = createPlayService({ storage: orca.storage, secrets });
  const launchOverrides = createLaunchOverrides({ log: (line) => orca.log?.('Toris Neon ' + line) });
  // Runs only when orca-plugin.json lists the hook; otherwise launches record "not applied".
  try { subscriptions.push(orca.hooks?.on?.('agent.launch.before', (event, next) => launchOverrides.handle(event, next))); }
  catch (error) { orca.log?.('Toris Neon: agent.launch.before hook unavailable: ' + String(error?.message ?? error)); }
  // Which code is running: version, commit, dev folder or installed release (src/buildinfo.mjs).
  const buildInfo = await readBuildInfo({ root: fileURLToPath(new URL('..', import.meta.url)) });
  if (buildInfo.error) orca.log?.('Toris Neon build info: ' + buildInfo.error);
  const runtime = createRuntime({
    orca, buildInfo, resolvePlayAccount: play.submissionAccount, readPlayApp: (input) => play.appSnapshot(input), eccAdvisor: createEccAdvisor(),
    visualAdvisor: createVisualAdvisor(), launchOverrides
  });
  activeRuntime = runtime;
  await runtime.initialize();
  const today = createTodayService({ orca, getState: runtime.getState });
  // Which stages can run (src/preflight.mjs): on the run card, and fresh before every start. Reports only.
  const preflight = createPreflight({
    getRun: (runId) => runtime.handlers['runs.get']({ runId }),
    call: (method, params) => orca.host.call(method, params),
    submissionAccounts: () => play.listSubmissionAccounts()
  });
  const handlers = {
    ...runtime.handlers,
    ...preflightHandlers({ preflight, start: runtime.handlers['runs.start'], log: (line) => orca.log?.(line) }),
    'play.list': () => play.list(),
    'play.submissionAccounts': () => play.listSubmissionAccounts(),
    'play.account.save': (input) => play.saveAccount(input),
    'play.account.remove': (input) => play.removeAccount(input),
    'play.check': (input) => play.check(input),
    'today.snapshot': (input) => today.snapshot(input),
    'today.save': (input) => today.save(input),
    'today.resume': (input) => today.resume(input)
  };
  for (const [name, handler] of Object.entries(handlers)) {
    subscriptions.push(orca.panels.handle(name, (input) => handler(inputObject(input))));
  }
  subscriptions.push(
    orca.commands.register('neon.today', async () => {
      const summary = await today.snapshot({});
      return JSON.stringify(summary, null, 2);
    }),
    orca.commands.register('neon.graph', () => {
      const state = runtime.getState();
      return state.runs.length
        ? state.runs.map((run) => run.goal + ' · ' + run.status + ' · ' + run.nodes.filter((node) => node.status === 'passed').length + '/' + run.nodes.length).join('\n')
        : '오른쪽 사이드바의 TORIS NEON 패널에서 Auto App 실행 계획을 만드세요.';
    }),
    orca.commands.register('neon.play', async () => {
      const { accounts } = await play.list();
      return accounts.length
        ? accounts.map((account) => account.name + ' · ' + (account.hasCredential ? '연결됨' : '계정 설정 확인')).join('\n')
        : '오른쪽 TORIS NEON → Play Store에서 읽기 전용 서비스 계정을 연결하세요.';
    })
  );
  orca.log?.('TORIS NEON worker ready. Saved runs reconciled; no previous task was launched twice.');
}

export async function deactivate() {
  activeRuntime?.dispose();
  for (const subscription of subscriptions.splice(0)) subscription?.dispose?.();
  await activeRuntime?.flush();
  activeRuntime = undefined;
}
