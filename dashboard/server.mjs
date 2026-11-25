/**
 * Auto APP dashboard v1: a read-only page of Neon runs, Orca workspaces, Play status and git activity.
 * Binds to 127.0.0.1 only; reach it from the phone through `tailscale serve` (tailnet only, see README).
 * Every API body passes scrub(): home paths shortened, emails and Play account ids removed.
 *   node dashboard/server.mjs            → http://127.0.0.1:4317  (DASH_PORT to change)
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModel } from './model.mjs';
import { scrub } from './join.mjs';
import { HOME } from './sources.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = Number(process.env.DASH_PORT ?? 4317);
const HOST = '127.0.0.1'; // never 0.0.0.0: the tailnet reaches it through tailscale serve
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };
const HEADERS = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};
// DNS rebinding guard: only this machine's loopback names and its tailnet (*.ts.net) name.
const allowedHost = (host = '') => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net(:\d+)?$/i.test(host);

/** A static file of this dashboard or a panel module it imports; flat names only. */
function staticFile(pathname) {
  if (pathname === '/') return 'dashboard/index.html';
  const own = /^\/([\w-]+\.(?:css|mjs))$/.exec(pathname);
  if (own) return 'dashboard/' + own[1];
  const panel = /^\/panel\/([\w-]+\.(?:css|mjs))$/.exec(pathname);
  return panel ? 'panel/' + panel[1] : null;
}

export function createServer(model = createModel()) {
  const json = (res, status, body) => { res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(scrub(body, { home: HOME }))); };
  return http.createServer(async (req, res) => {
    try {
      if (!allowedHost(req.headers.host)) { res.writeHead(421, HEADERS); res.end('Misdirected host'); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, HEADERS); res.end(); return; }
      const { pathname, searchParams } = new URL(req.url, 'http://localhost');
      if (pathname === '/healthz') { json(res, 200, { ok: true }); return; }
      if (pathname === '/api/snapshot') { json(res, 200, await model.snapshot()); return; }
      if (pathname === '/api/run') {
        const run = await model.runDetail(searchParams.get('id') ?? '');
        if (run) json(res, 200, run); else json(res, 404, { error: '실행을 찾을 수 없습니다' });
        return;
      }
      if (pathname === '/api/file') {
        const found = await model.file(Object.fromEntries(searchParams)).catch((error) => ({ error: error.message }));
        if (!found || found.error || found.kind !== 'image') { json(res, 404, { error: found?.error ?? found?.text ?? '표시할 수 없는 파일입니다' }); return; }
        res.writeHead(200, { ...HEADERS, 'Content-Type': found.mime, 'Cache-Control': 'private, max-age=300' });
        res.end(Buffer.from(found.data, 'base64'));
        return;
      }
      const file = staticFile(pathname);
      if (!file) { res.writeHead(404, HEADERS); res.end('Not found'); return; }
      const body = await fs.readFile(path.join(ROOT, file)).catch(() => null);
      if (!body) { res.writeHead(404, HEADERS); res.end('Not found'); return; }
      res.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[path.extname(file)] });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      console.error(new Date().toISOString(), req.url, error);
      json(res, 500, { error: '대시보드 데이터를 만들지 못했습니다: ' + error.message });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, HOST, () => console.log('Auto APP dashboard: http://' + HOST + ':' + PORT));
}
