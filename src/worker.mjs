import { createRuntime } from './runtime.mjs';
import { createPlayService } from './play.mjs';
import { createTodayService } from './today.mjs';

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
  const runtime = createRuntime({ orca });
  activeRuntime = runtime;
  await runtime.initialize();
  const secrets = {
    get: async (key) => (await orca.host.call('secrets.get', { key })).value,
    set: (key, value) => orca.host.call('secrets.set', { key, value }),
    delete: (key) => orca.host.call('secrets.delete', { key }),
    protection: () => orca.host.call('secrets.protection', {})
  };
  const play = createPlayService({ storage: orca.storage, secrets });
  const today = createTodayService({ orca, getState: runtime.getState });
  const handlers = {
    ...runtime.handlers,
    'play.list': () => play.list(),
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
