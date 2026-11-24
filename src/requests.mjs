/**
 * Roadmap item 7: the request keys (runs.create requestId, remote and Play action keys, diagnosis
 * candidates) of runs pushed out of the archive limit, so a late redelivery of the same request
 * never creates a second run. One small value of its own, bounded to the newest MAX_PRUNED keys.
 * A failed write keeps the keys in memory until the next restart and is logged.
 */
export const REQUESTS_KEY = 'toris-neon.requests.v1';
export const MAX_PRUNED = 200;
const valid = (entry) => typeof entry?.requestId === 'string' && typeof entry.id === 'string';

const merge = (base, extra) => [...base.filter((entry) => !extra.some((item) => item.requestId === entry.requestId)), ...extra].slice(-MAX_PRUNED);

export function createRequestLedger(storage, log = () => {}) {
  let entries = [], readable = false; // never write over stored keys that could not be read
  const read = async () => { const saved = await storage.get(REQUESTS_KEY); return Array.isArray(saved?.entries) ? saved.entries.filter(valid) : []; };
  return {
    async load() {
      try { entries = merge(await read(), entries); readable = true; }
      catch (error) { log('Toris Neon storage: 정리된 실행의 요청 키를 읽지 못했습니다: ' + String(error?.message ?? error)); }
    },
    /** Keeps the request key of every run in `runs` that has one. */
    async remember(runs, at) {
      const added = runs.filter((run) => typeof run.requestId === 'string')
        .map((run) => ({ requestId: run.requestId, id: run.id, status: run.status, projectId: run.projectId ?? null, prunedAt: at, pruned: true }));
      if (!added.length) return;
      entries = merge(entries, added);
      if (!readable) await this.load();
      if (!readable) { log('Toris Neon storage: 저장된 요청 키를 읽지 못해 덮어쓰지 않고 메모리에만 둡니다.'); return; }
      try { await storage.set(REQUESTS_KEY, { version: 1, entries }); }
      catch (error) { log('Toris Neon storage: 정리된 실행의 요청 키를 저장하지 못했습니다(재시작 전까지는 메모리에 유지): ' + String(error?.message ?? error)); }
    },
    list: () => entries.map((entry) => ({ ...entry })),
  };
}
