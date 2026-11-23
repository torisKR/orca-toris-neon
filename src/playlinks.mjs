/**
 * Plan 5.3: a Play app linked to a local Orca project, kept in plugin storage. Several Play accounts
 * exist, so a link is never made from an app name: the person picks a developer account (with its
 * 19-digit id), a package registered in that account and the project. A link whose account id
 * changed, whose package left the account or whose project is gone shows that problem and starts
 * nothing until the person links it again.
 */
import { fileIo } from './ecc.mjs';
import { projectPlatform } from './kinds.mjs';

export const LINKS_KEY = 'toris-neon.play.links.v1';
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const MAX_LINKS = 200;
const fail = (code, message) => Object.assign(new Error(message), { code });
const invalid = (message) => fail('invalid_params', message);
const same = (link, { accountId, packageName }) => link.accountId === accountId && link.packageName === packageName;

function key(input = {}) {
  const { accountId, packageName } = input;
  if (typeof accountId !== 'string' || !/^[\w-]{1,80}$/.test(accountId)) throw invalid('Play 계정을 선택하세요.');
  if (typeof packageName !== 'string' || !PACKAGE.test(packageName)) throw invalid('Play 패키지 이름(예: com.example.app)을 선택하세요. 앱 이름으로는 연결하지 않습니다.');
  return { accountId, packageName };
}

/** Why `link` cannot be used now, or null. `projects` is null when Orca's list could not be read: then it is unconfirmed, never healthy. */
function problemOf(link, accounts, projects) {
  const account = accounts.find((item) => item.id === link.accountId);
  if (!account) return '연결한 Play 계정이 Play Store 탭에서 삭제됐습니다. 계정을 다시 연결한 뒤 앱을 연결하세요.';
  if (account.developerId !== link.developerId) return 'Play 개발자 계정 ID가 연결할 때와 다릅니다. 계정을 확인하고 다시 연결하세요.';
  if (!account.packages.includes(link.packageName)) return '이 패키지가 계정 설정의 패키지 목록에 없습니다. 계정 설정에 패키지를 추가하거나 연결을 해제하세요.';
  if (!projects) return 'Orca 프로젝트 목록을 읽지 못해 이 연결을 확인하지 못했습니다. 새로고침한 뒤 다시 확인하세요.';
  if (!projects.some((project) => project.id === link.projectId)) return '연결한 Orca 프로젝트를 찾을 수 없습니다. 다른 프로젝트에 다시 연결하세요.';
  return null;
}

export function createPlayLinks({ storage, listAccounts, call, detectPlatform = (root) => projectPlatform(root, fileIo), now = Date.now }) {
  let tail = Promise.resolve();
  const serial = (action) => { const work = tail.then(action, action); tail = work.catch(() => {}); return work; };
  async function load() {
    const value = await storage.get(LINKS_KEY);
    if (value == null) return [];
    if (value.version !== 1 || !Array.isArray(value.links)) throw fail('state_corrupt', '저장된 Play 앱 연결 형식을 확인하지 못했습니다. 기존 데이터를 덮어쓰지 않습니다.');
    return value.links;
  }
  const store = (links) => storage.set(LINKS_KEY, { version: 1, links });
  const accountsNow = async () => {
    const { accounts } = await listAccounts() ?? {};
    if (!Array.isArray(accounts)) throw fail('unavailable', 'Play 계정 목록을 읽지 못했습니다. 연결을 확인하거나 바꾸지 않습니다.');
    return accounts;
  };
  const projectsNow = async () => (await call('project.list', {})).projects ?? [];
  const view = (link, accounts, projects) => ({ ...link, problem: problemOf(link, accounts, projects) });

  return {
    /** Every link with its current problem; `accounts` saves a second Play read when the caller has them. */
    async list({ accounts } = {}) {
      const links = await load();
      if (!links.length) return [];
      let projects = null;
      try { projects = await projectsNow(); } catch { projects = null; } // each link then says it could not be confirmed
      const current = accounts ?? await accountsNow();
      return links.map((link) => view(link, current, projects));
    },
    save(input = {}) {
      return serial(async () => {
        const target = key(input);
        if (typeof input.projectId !== 'string' || !input.projectId) throw invalid('연결할 Orca 프로젝트를 선택하세요.');
        const links = await load();
        const account = (await accountsNow()).find((item) => item.id === target.accountId);
        if (!account) throw invalid('Play 계정을 찾을 수 없습니다. Play Store 탭에서 계정을 확인하세요.');
        if (!account.developerId) throw invalid('Play 계정 설정에 19자리 개발자 계정 ID를 먼저 입력하세요. 계정이 여럿이라 ID 없이 연결하지 않습니다.');
        if (!account.packages.includes(target.packageName)) throw invalid('이 패키지는 선택한 계정의 패키지 목록에 없습니다. 계정 설정에 패키지를 추가한 뒤 연결하세요.');
        const project = (await projectsNow()).find((item) => item.id === input.projectId);
        if (!project) throw invalid('선택한 Orca 프로젝트를 찾을 수 없습니다.');
        if ((project.hostId && project.hostId !== 'local') || !project.path) throw invalid('로컬 Git 프로젝트에만 Play 앱을 연결할 수 있습니다.');
        if (await detectPlatform(project.path) === 'web') throw invalid('웹 프로젝트에는 Play 앱을 연결하지 않습니다.');
        const others = links.filter((link) => !same(link, target));
        if (others.length >= MAX_LINKS) throw invalid('Play 앱 연결은 최대 ' + MAX_LINKS + '개까지 저장합니다.');
        const link = { ...target, developerId: account.developerId, accountName: account.name, projectId: project.id,
          projectName: project.name ?? project.id, linkedAt: new Date(now()).toISOString() };
        await store([...others, link]);
        return view(link, [account], [project]);
      });
    },
    remove(input = {}) {
      return serial(async () => {
        const target = key(input);
        const links = await load();
        if (!links.some((link) => same(link, target))) throw invalid('이 Play 앱은 연결돼 있지 않습니다.');
        await store(links.filter((link) => !same(link, target)));
        return { removed: true, ...target };
      });
    },
    /** The link of this account and package, checked against current accounts and projects; throws its problem. */
    async resolve(input = {}) {
      const target = key(input);
      const link = (await load()).find((item) => same(item, target));
      if (!link) throw invalid('이 Play 앱은 아직 Orca 프로젝트에 연결되지 않았습니다. 먼저 프로젝트를 연결하세요.');
      const problem = problemOf(link, await accountsNow(), await projectsNow());
      if (problem) throw invalid(problem);
      return { ...link, problem: null };
    },
  };
}
