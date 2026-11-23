import { createPrivateKey, createSign, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

// GET-only release inspection. The OAuth token exchange is the sole POST.
// https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases/list
// https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases
// https://developers.google.com/play/developer/reporting/reference/rest/v1beta1/apps/search
export const DEFAULT_TRACKS = Object.freeze(["production", "beta", "alpha", "internal"]);
export const PLAY_STORAGE_KEY = "toris-neon.play.accounts.v1";
export const PLAY_TOKEN_URL = "https://oauth2.googleapis.com/token";
const REPORTING_URL = "https://playdeveloperreporting.googleapis.com/v1beta1/apps:search";
const PUBLISHER_URL = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const SCOPES = "https://www.googleapis.com/auth/androidpublisher https://www.googleapis.com/auth/playdeveloperreporting";
const MAX_KEY_BYTES = 65536;
const MAX_PACKAGES = 200;
const MAX_PAGES = 20;
const CACHE_TTL_MS = 3600000;
const REQUEST_TIMEOUT_MS = 15000;
const secretKey = id => `play.service-account.${id}`;
const cacheKey = id => `toris-neon.play.cache.v1.${id}`;
const text = (value, limit = 200) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit);
const clone = value => structuredClone(value);
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const developerIdPattern = /^\d{19}$/;

export class PlayError extends Error {
  constructor(code, message, { status = null, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = "PlayError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const publicError = error => ({
  code: error instanceof PlayError ? error.code : "unavailable",
  message: error instanceof PlayError ? error.message : "The Play check could not complete. Try again after checking the connection.",
  ...(error instanceof PlayError && error.status ? { status: error.status } : {}),
});

function inputs(value, kind, defaults = []) {
  if (value === undefined) return [...defaults];
  if (!Array.isArray(value)) throw new PlayError("invalid_input", `${kind} must be an array.`);
  const maximum = kind === "tracks" ? 20 : MAX_PACKAGES;
  if (value.length > maximum) throw new PlayError("invalid_input", `At most ${maximum} ${kind} are supported per account.`);
  const pattern = kind === "tracks" ? /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/ : /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
  const result = [...new Set(value.map(item => {
    if (typeof item !== "string" || !pattern.test(item)) throw new PlayError("invalid_input", `An invalid ${kind === "tracks" ? "track" : "package name"} was supplied.`);
    return item;
  }))];
  if (kind === "tracks" && !result.length) throw new PlayError("invalid_input", "Choose at least one track.");
  return result;
}

function parseCredential(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_KEY_BYTES) throw new PlayError("invalid_credential", "Use a service account JSON file smaller than 64 KB.");
  let key;
  try { key = JSON.parse(raw); } catch { throw new PlayError("invalid_credential", "The service account JSON is invalid."); }
  if (!isRecord(key) || key.type !== "service_account" || typeof key.client_email !== "string" ||
      key.client_email.length > 254 || !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(key.client_email) ||
      typeof key.private_key !== "string" || key.private_key.length > MAX_KEY_BYTES) {
    throw new PlayError("invalid_credential", "A Google service account JSON with an RSA private key is required.");
  }
  try {
    const parsed = createPrivateKey(key.private_key);
    if (parsed.asymmetricKeyType !== "rsa") throw new Error("not RSA");
  } catch { throw new PlayError("invalid_credential", "The service account private key is not a valid RSA key."); }
  // token_uri and all other fields are deliberately discarded. Never send credentials to an input URL.
  return { type: "service_account", client_email: key.client_email, private_key: key.private_key };
}

export function normalizeRelease(release) {
  if (!isRecord(release)) throw new PlayError("invalid_response", "Google returned an invalid release response.");
  const raw = String(release.releaseLifecycleState ?? "").replace(/^RELEASE_LIFECYCLE_STATE_/, "").toLowerCase();
  const allowed = ["draft", "not_sent_for_review", "in_review", "approved_not_published", "not_approved", "published"];
  const artifacts = Array.isArray(release.activeArtifacts) ? release.activeArtifacts : [];
  return {
    name: text(release.releaseName, 160),
    versionCodes: [...new Set(artifacts.map(item => item?.versionCode).filter(code => (typeof code === "number" || typeof code === "string") && /^\d+$/.test(String(code)))
      .map(Number).filter(code => Number.isSafeInteger(code) && code > 0))],
    state: allowed.includes(raw) ? raw : "unknown",
  };
}

/** PUBLISHED includes partial and resumable halted rollouts; it is not a 100% rollout assertion. */
export function summarizeApp(tracks) {
  const production = tracks.filter(item => item.track === "production" || item.track.endsWith(":production"));
  const all = tracks.flatMap(item => item.releases);
  const published = production.some(item => item.releases.some(release => release.state === "published"));
  const top = release => Math.max(0, ...release.versionCodes);
  const rejected = tracks.some(item => item.releases.some(release => release.state === "not_approved" &&
    !item.releases.some(newer => ["published", "approved_not_published"].includes(newer.state) && top(newer) > top(release))));
  const has = state => all.some(release => release.state === state);
  const incomplete = tracks.some(item => item.error || item.stale || !item.observedAt);
  const status = rejected ? "rejected" : has("in_review") ? "in_review" : has("approved_not_published") ? "approved_not_published"
    : has("draft") || has("not_sent_for_review") ? "draft" : published ? "published"
    : all.length ? (has("unknown") ? "unknown" : "testing") : incomplete ? "unknown" : "no_release";
  return { status, published, needsAttention: incomplete || ["rejected", "approved_not_published", "draft", "unknown"].includes(status) };
}

function httpError(status, retryAfterMs = 0, auth = false) {
  if (status === 429) return new PlayError("rate_limited", "Google Play rate limit reached. Cached observations are retained; wait before checking again.", { status, retryAfterMs: Math.max(60000, retryAfterMs) });
  if (auth) return new PlayError("authentication", "Google could not authenticate this service account. Check the key and Google API access.", { status });
  if (status === 401) return new PlayError("authentication", "Google rejected the access token. Check the service account credentials.", { status });
  if (status === 403) return new PlayError("permission", "Google denied access. Enable the Play APIs and grant this service account access in Play Console.", { status });
  if (status === 404) return new PlayError("not_found", "Google could not find this package or track. Check its configured name and account access.", { status });
  return new PlayError("google_error", `Google Play returned HTTP ${status}. Previous observations are retained.`, { status });
}

/**
 * Adapter contract: storage.get/set(key,value); secrets.get/set/delete and
 * secrets.protection() -> {status:"os-keyring"|"unavailable"}.
 * All cache and credential values stay local to Orca. Panel responses never include the key/email/path/token.
 */
export function createPlayService({ storage, secrets, fetch: fetcher = globalThis.fetch, now = Date.now,
  readCredentialFile, requestTimeoutMs = REQUEST_TIMEOUT_MS, cacheTtlMs = CACHE_TTL_MS } = {}) {
  if (!storage?.get || !storage?.set || !secrets?.get || !secrets?.set || !secrets?.delete || !secrets?.protection) {
    throw new PlayError("adapter", "Play Check needs Orca storage and protected secrets support.");
  }
  const tokens = new Map();
  const checks = new Map();
  const activeChecks = new Set();
  const cooldowns = new Map();
  let mutation = Promise.resolve();
  let activeRequests = 0;
  const waiting = [];

  const serialized = fn => {
    const work = mutation.then(fn, fn);
    mutation = work.catch(() => {});
    return work;
  };
  const iso = () => new Date(now()).toISOString();
  const isFresh = observedAt => {
    const age = typeof observedAt === "string" ? now() - Date.parse(observedAt) : NaN;
    return Number.isFinite(age) && age >= 0 && age < cacheTtlMs;
  };
  async function protection() {
    try { const result = await secrets.protection(); return { status: result?.status === "os-keyring" ? "os-keyring" : "unavailable" }; }
    catch { return { status: "unavailable" }; }
  }
  async function requireProtection() {
    if ((await protection()).status !== "os-keyring") throw new PlayError("keyring_unavailable", "Protected OS keyring storage is unavailable. Unlock or configure the OS keyring before adding or using a Play account.");
  }
  async function readStoredCredential(id) {
    try { return await secrets.get(secretKey(id)); }
    catch { throw new PlayError("credential_unavailable", "The saved service account credential could not be unlocked."); }
  }
  async function restoreCredential(id, value) {
    try {
      if (value == null) await secrets.delete(secretKey(id));
      else { await requireProtection(); await secrets.set(secretKey(id), value); }
    } catch {
      throw new PlayError("credential_update_uncertain", "Account settings could not be saved and credential recovery could not be confirmed. Check OS keyring access and save the intended credential again.");
    }
  }
  async function loadAccounts() {
    let value;
    try { value = await storage.get(PLAY_STORAGE_KEY); } catch { throw new PlayError("storage", "Play account settings could not be read."); }
    if (value === null || value === undefined) return [];
    if (value?.version !== 1 || !Array.isArray(value.accounts)) throw new PlayError("storage", "Saved Play account settings are invalid.");
    return clone(value.accounts);
  }
  async function saveAccounts(accounts) {
    try { await storage.set(PLAY_STORAGE_KEY, { version: 1, accounts }); }
    catch { throw new PlayError("storage", "Play account settings could not be saved."); }
  }
  async function loadCache(id) {
    try { const value = await storage.get(cacheKey(id)); return value?.version === 1 ? clone(value) : { version: 1, apps: [] }; }
    catch { throw new PlayError("storage", "Saved Play observations could not be read."); }
  }
  async function storeCache(id, value) {
    try { await storage.set(cacheKey(id), value); }
    catch { throw new PlayError("storage", "Play observations could not be saved."); }
  }
  function accountView(account, cache) {
    const ageStale = observedAt => !isFresh(observedAt);
    const selected = new Set(account.packages);
    const apps = (cache.apps ?? []).filter(app => !selected.size || selected.has(app.packageName)).map(app => {
      const tracks = account.tracks.map(track => {
        const saved = app.tracks?.find(item => item.track === track);
        return saved ? { ...saved, stale: Boolean(saved.stale || ageStale(saved.observedAt)) }
          : { track, releases: [], observedAt: null, attemptedAt: null, stale: true, error: null };
      });
      return { packageName: app.packageName, name: app.name, storeUrl: `https://play.google.com/store/apps/details?id=${encodeURIComponent(app.packageName)}`, tracks, ...summarizeApp(tracks) };
    });
    return {
      id: account.id, name: account.name, developerId: account.developerId ?? null,
      packages: [...account.packages], tracks: [...account.tracks], hasCredential: true,
      createdAt: account.createdAt, updatedAt: account.updatedAt,
      attemptedAt: cache.attemptedAt ?? null, checkedAt: cache.checkedAt ?? null, error: cache.error ?? null,
      discovery: { observedAt: cache.discovery?.observedAt ?? null,
        stale: Boolean(cache.discovery?.stale || ageStale(cache.discovery?.observedAt)), error: cache.discovery?.error ?? null },
      apps,
    };
  }
  async function getAccount(id) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new PlayError("invalid_input", "Choose a saved Play account.");
    const account = (await loadAccounts()).find(item => item.id === id);
    if (!account) throw new PlayError("not_found", "That Play account is not registered.");
    return account;
  }
  async function limited(fn) {
    if (activeRequests >= 3) await new Promise(resolveWait => waiting.push(resolveWait));
    else activeRequests++;
    try { return await fn(); }
    finally { if (waiting.length) waiting.shift()(); else activeRequests--; }
  }
  async function request(url, { method = "GET", headers = {}, body, auth = false } = {}) {
    // Fixed Google hosts and explicit token endpoint; redirects are never followed with credentials.
    const allowed = method === "POST" ? url === PLAY_TOKEN_URL
      : method === "GET" && (url.startsWith(REPORTING_URL + "?") || url.startsWith(PUBLISHER_URL + "/"));
    if (!allowed) throw new PlayError("request_rejected", "This request is outside read-only Play Check.");
    return limited(async () => {
      let response;
      try { response = await fetcher(url, { method, headers, ...(body === undefined ? {} : { body }), redirect: "error", signal: AbortSignal.timeout(requestTimeoutMs) }); }
      catch { throw new PlayError("network", "Google Play could not be reached or the request timed out. Cached observations are retained."); }
      if (!response.ok) {
        const retry = response.headers?.get?.("retry-after");
        const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Math.max(0, Date.parse(retry) - now()) : 0;
        throw httpError(response.status, Number.isFinite(delay) ? delay : 0, auth);
      }
      if (response.status === 204) return {};
      try { const value = await response.json(); if (!isRecord(value)) throw new Error(); return value; }
      catch { throw new PlayError("invalid_response", "Google returned an invalid JSON response."); }
    });
  }
  async function tokenFor(account) {
    const cached = tokens.get(account.id);
    if (cached && now() < cached.expiresAt - 60000) return cached.value;
    await requireProtection();
    let raw;
    try { raw = await secrets.get(secretKey(account.id)); } catch { throw new PlayError("credential_unavailable", "The saved service account credential could not be unlocked."); }
    if (!raw) throw new PlayError("credential_unavailable", "The saved service account credential is missing. Add its JSON again.");
    const key = parseCredential(raw);
    const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    const seconds = Math.floor(now() / 1000);
    const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: key.client_email, scope: SCOPES, aud: PLAY_TOKEN_URL, iat: seconds, exp: seconds + 900 })}`;
    let signature;
    try { signature = createSign("RSA-SHA256").update(payload).sign(key.private_key).toString("base64url"); }
    catch { throw new PlayError("invalid_credential", "The service account could not sign an access request."); }
    const response = await request(PLAY_TOKEN_URL, { method: "POST", auth: true,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${payload}.${signature}` }).toString() });
    if (typeof response.access_token !== "string" || !response.access_token || response.access_token.length > 16384) throw new PlayError("authentication", "Google returned no usable access token.");
    const expires = Number(response.expires_in);
    const lifetime = Number.isFinite(expires) && expires > 0 ? Math.min(expires, 3600) : 900;
    tokens.set(account.id, { value: response.access_token, expiresAt: now() + lifetime * 1000 });
    return response.access_token;
  }
  async function discover(bearer) {
    const apps = new Map(), seen = new Set();
    let page = "";
    for (let count = 0; count < MAX_PAGES; count++) {
      const suffix = page ? `&pageToken=${encodeURIComponent(page)}` : "";
      const response = await request(`${REPORTING_URL}?pageSize=100${suffix}`, { headers: { authorization: `Bearer ${bearer}` } });
      if (response.apps !== undefined && !Array.isArray(response.apps)) throw new PlayError("invalid_response", "Google returned an invalid app list.");
      for (const app of response.apps ?? []) {
        if (typeof app?.packageName !== "string" || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(app.packageName)) continue;
        apps.set(app.packageName, { packageName: app.packageName, name: text(app.displayName, 160) || app.packageName });
        if (apps.size > MAX_PACKAGES) throw new PlayError("account_limit", `This account exceeds the ${MAX_PACKAGES}-app check limit. Configure a narrower package list.`);
      }
      page = response.nextPageToken ?? "";
      if (!page) return [...apps.values()];
      if (typeof page !== "string" || page.length > 4096 || seen.has(page)) throw new PlayError("pagination", "Google returned an invalid or repeated page token.");
      seen.add(page);
    }
    throw new PlayError("pagination", "App discovery exceeded its page limit. Configure package names explicitly.");
  }
  function staleCache(cache, error, at) {
    return { ...cache, attemptedAt: at, error: publicError(error),
      discovery: { ...(cache.discovery ?? {}), stale: true, error: publicError(error) },
      apps: (cache.apps ?? []).map(app => ({ ...app, tracks: (app.tracks ?? []).map(track => ({ ...track, attemptedAt: at, stale: true, error: publicError(error) })) })) };
  }
  async function readReleases(account, packageName, track, bearer) {
    if ((cooldowns.get(account.id) ?? 0) > now()) throw httpError(429);
    try {
      const response = await request(`${PUBLISHER_URL}/${encodeURIComponent(packageName)}/tracks/${encodeURIComponent(track)}/releases`, { headers: { authorization: `Bearer ${bearer}` } });
      if (response.releases !== undefined && !Array.isArray(response.releases)) throw new PlayError("invalid_response", "Google returned an invalid releases list.");
      return (response.releases ?? []).map(normalizeRelease);
    } catch (error) {
      if (error.status === 401) tokens.delete(account.id);
      if (error.retryAfterMs) cooldowns.set(account.id, Math.max(cooldowns.get(account.id) ?? 0, now() + error.retryAfterMs));
      throw error;
    }
  }
  async function performCheck(accountId, force) {
    const account = await getAccount(accountId);
    const before = await loadCache(accountId);
    const cachedView = accountView(account, before);
    if (!force && isFresh(before.checkedAt) && !before.error && !cachedView.discovery.stale && !cachedView.discovery.error &&
        cachedView.apps.every(app => app.tracks.every(track => !track.stale && !track.error))) return cachedView;
    if ((cooldowns.get(accountId) ?? 0) > now()) return accountView(account, before);
    const at = iso();
    let bearer;
    try { bearer = await tokenFor(account); }
    catch (error) {
      if (error.retryAfterMs) cooldowns.set(accountId, now() + error.retryAfterMs);
      const failed = staleCache(before, error, at);
      await storeCache(accountId, failed);
      return accountView(account, failed);
    }
    let discovered = [], discovery = { observedAt: at, stale: false, error: null };
    try { discovered = await discover(bearer); discovery.observedAt = iso(); }
    catch (error) {
      if (error.status === 401) tokens.delete(accountId);
      discovery = { observedAt: before.discovery?.observedAt ?? null, stale: true, error: publicError(error) };
      discovered = (before.apps ?? []).map(app => ({ packageName: app.packageName, name: app.name }));
      if (error.status === 401 || error.retryAfterMs) {
        if (error.retryAfterMs) cooldowns.set(accountId, Math.max(cooldowns.get(accountId) ?? 0, now() + error.retryAfterMs));
        const failed = staleCache(before, error, at);
        await storeCache(accountId, failed);
        return accountView(account, failed);
      }
    }
    const chosen = new Map(discovered.map(app => [app.packageName, app]));
    // Explicit package names are an allowlist; an empty list inspects every discovered app.
    const candidates = (account.packages.length ? account.packages.map(packageName => chosen.get(packageName) ?? { packageName, name: packageName })
      : [...chosen.values()]).slice(0, MAX_PACKAGES);
    let stopError = null;
    const jobs = candidates.flatMap(app => account.tracks.map(track => ({ app, track })));
    const outcomes = new Array(jobs.length);
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => {
      while (index < jobs.length) {
        const slot = index++, { app, track } = jobs[slot];
        const old = before.apps?.find(item => item.packageName === app.packageName)?.tracks?.find(item => item.track === track);
        try {
          if (stopError) throw stopError;
          const releases = await readReleases(account, app.packageName, track, bearer);
          outcomes[slot] = { track, releases, observedAt: iso(), attemptedAt: at, stale: false, error: null };
        } catch (error) {
          if (error.status === 401 || error.retryAfterMs) stopError ??= error;
          outcomes[slot] = { track, releases: old?.releases ?? [], observedAt: old?.observedAt ?? null, attemptedAt: at, stale: true, error: publicError(error) };
        }
      }
    }));
    const apps = candidates.map((app, position) => ({ ...app, tracks: outcomes.slice(position * account.tracks.length, (position + 1) * account.tracks.length) }));
    const incomplete = discovery.error || apps.some(app => app.tracks.some(track => track.error));
    const after = { version: 1, attemptedAt: at, checkedAt: incomplete ? before.checkedAt ?? null : iso(),
      discovery, apps, error: discovery.error ?? (stopError ? publicError(stopError) : incomplete ? { code: "partial", message: "Some tracks could not be checked. Their previous observations are shown as stale." } : null) };
    await storeCache(accountId, after);
    return accountView(account, after);
  }

  return {
    async list() {
      const accounts = await loadAccounts();
      return { version: 1, protection: await protection(), accounts: await Promise.all(accounts.map(async account => accountView(account, await loadCache(account.id)))) };
    },
    async listSubmissionAccounts() {
      return (await loadAccounts()).filter(account => account.developerId && account.packages.length)
        .map(({ id, name, developerId }) => ({ id, name, developerId }));
    },
    async submissionAccount({ accountId, developerId, packageName, track }, { verifyAccess = false } = {}) {
      return serialized(async () => {
        if (typeof developerId !== "string" || !developerIdPattern.test(developerId)) {
          throw new PlayError("invalid_input", "Play 개발자 계정을 선택해 다시 승인해 주세요.");
        }
        const account = await getAccount(accountId);
        if (account.developerId !== developerId) throw new PlayError("invalid_input", "Play 개발자 계정이 변경됐습니다. 계정을 확인해 다시 승인해 주세요.");
        if (!account.packages.includes(packageName)) throw new PlayError("invalid_input", "이 패키지는 선택한 개발자 계정에 등록되어 있지 않습니다. Play Store 계정 설정에서 패키지를 확인해 주세요.");
        if (verifyAccess) {
          if ((cooldowns.get(account.id) ?? 0) > now()) throw httpError(429);
          const bearer = await tokenFor(account);
          await readReleases(account, packageName, track, bearer);
        }
        return { accountId: account.id, developerId: account.developerId, accountName: account.name };
      });
    },
    async saveAccount(input = {}) {
      return serialized(async () => {
        const accounts = await loadAccounts();
        if (input.id !== undefined && (typeof input.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.id))) throw new PlayError("invalid_input", "Choose a saved Play account.");
        const current = input.id ? accounts.find(account => account.id === input.id) : null;
        if (input.id && !current) throw new PlayError("not_found", "That Play account is not registered.");
        if (current && activeChecks.has(current.id)) throw new PlayError("busy", "Wait for this account's check to finish before editing it.");
        const name = typeof input.name === "string" ? text(input.name, 80) : current?.name ?? "";
        if (!name) throw new PlayError("invalid_input", "Give this Play account a name.");
        const developerId = input.developerId === undefined ? current?.developerId ?? null : input.developerId;
        if (developerId !== null && (typeof developerId !== "string" || !developerIdPattern.test(developerId))) {
          throw new PlayError("invalid_input", "Play Console의 19자리 개발자 계정 ID를 입력해 주세요.");
        }
        if (developerId && accounts.some(account => account.id !== current?.id && account.developerId === developerId)) {
          throw new PlayError("invalid_input", "이 Play 개발자 계정은 이미 연결되어 있습니다.");
        }
        const packages = inputs(input.packages, "packages", current?.packages ?? []);
        const tracks = inputs(input.tracks, "tracks", current?.tracks ?? DEFAULT_TRACKS);
        const suppliedJson = input.serviceAccountJson !== undefined && input.serviceAccountJson !== "";
        const suppliedPath = input.credentialPath !== undefined && input.credentialPath !== "";
        if (suppliedJson && suppliedPath) throw new PlayError("invalid_input", "Supply either service account JSON or its local file path.");
        let key = null;
        if (suppliedJson || suppliedPath) {
          await requireProtection();
          let raw = input.serviceAccountJson;
          if (suppliedPath) {
            if (typeof input.credentialPath !== "string" || input.credentialPath.length > 4096) throw new PlayError("invalid_input", "Choose a valid local credential file.");
            try {
              const file = resolve(input.credentialPath.replace(/^~(?=$|[\\/])/, homedir()));
              if (readCredentialFile) raw = await readCredentialFile(file);
              else {
                const info = await stat(file);
                if (!info.isFile() || info.size > MAX_KEY_BYTES) throw new Error();
                raw = await readFile(file, "utf8");
              }
            } catch { throw new PlayError("credential_unavailable", "The selected service account file could not be read or is too large."); }
          }
          key = parseCredential(raw);
        } else if (!current) throw new PlayError("invalid_credential", "Add the service account JSON for this new account.");
        const id = current?.id ?? randomUUID();
        const previousKey = current && key ? await readStoredCredential(id) : null;
        // Invalidate first: an observation write failure must not leave changed credentials/settings
        // paired with an apparently fresh result from the previous configuration.
        let cache = await loadCache(id);
        if (current) cache = { ...cache, checkedAt: null, discovery: { ...(cache.discovery ?? {}), stale: true },
          apps: (cache.apps ?? []).map(app => ({ ...app, tracks: (app.tracks ?? []).map(track => ({ ...track, stale: true })) })) };
        await storeCache(id, cache);
        if (key) {
          tokens.delete(id);
          try { await secrets.set(secretKey(id), JSON.stringify(key)); }
          catch { throw new PlayError("keyring_unavailable", "The service account could not be saved in the protected OS keyring."); }
        }
        const account = { id, name, developerId, packages, tracks, createdAt: current?.createdAt ?? iso(), updatedAt: iso() };
        if (current) accounts[accounts.findIndex(item => item.id === id)] = account; else accounts.push(account);
        try { await saveAccounts(accounts); }
        catch (error) {
          if (key) await restoreCredential(id, previousKey);
          throw error;
        }
        return accountView(account, cache);
      });
    },
    async removeAccount({ accountId } = {}) {
      return serialized(async () => {
        const account = await getAccount(accountId);
        if (activeChecks.has(account.id)) throw new PlayError("busy", "Wait for this account's check to finish before removing it.");
        await requireProtection();
        const previousKey = await readStoredCredential(account.id);
        tokens.delete(account.id);
        try { await secrets.delete(secretKey(account.id)); } catch { throw new PlayError("keyring_unavailable", "The saved credential could not be removed from the OS keyring."); }
        try { await saveAccounts((await loadAccounts()).filter(item => item.id !== account.id)); }
        catch (error) { await restoreCredential(account.id, previousKey); throw error; }
        await storeCache(account.id, { version: 1, apps: [] });
        cooldowns.delete(account.id);
        return { removed: account.id };
      });
    },
    async check({ accountId, force = false } = {}) {
      if (checks.has(accountId)) return checks.get(accountId);
      // Earlier edits finish first. Only a check that has started can block a later edit.
      const work = mutation.then(async () => {
        activeChecks.add(accountId);
        try { return await performCheck(accountId, Boolean(force)); }
        finally { activeChecks.delete(accountId); }
      });
      checks.set(accountId, work);
      try { return await work; } finally { checks.delete(accountId); }
    },
  };
}
