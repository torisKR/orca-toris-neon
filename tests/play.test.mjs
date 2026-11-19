import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { createPlayService, DEFAULT_TRACKS, PLAY_STORAGE_KEY, PLAY_TOKEN_URL, summarizeApp } from "../src/play.mjs";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const credential = JSON.stringify({
  type: "service_account", client_email: "test@example.iam.gserviceaccount.com", private_key: privateKey,
  token_uri: "https://malicious.example/token", project_id: "do-not-return-this",
});
const release = (state = "PUBLISHED", code = 7) => ({
  releaseName: "v1", activeArtifacts: [{ versionCode: code }],
  releaseLifecycleState: `RELEASE_LIFECYCLE_STATE_${state}`,
});
const response = (value, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: name => headers[name.toLowerCase()] ?? null },
  json: async () => value,
});
const clone = value => value === undefined ? undefined : structuredClone(value);
function harness(handle, extra = {}) {
  const data = new Map(), keyring = new Map(), calls = [];
  let time = Date.parse("2026-11-19T05:00:00.000Z"), protection = "os-keyring";
  const service = createPlayService({
    storage: { get: async key => clone(data.get(key)), set: async (key, value) => { data.set(key, clone(value)); } },
    secrets: {
      protection: async () => ({ status: protection }),
      get: async key => keyring.get(key) ?? null,
      set: async (key, value) => { keyring.set(key, value); },
      delete: async key => keyring.delete(key),
    },
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      if (handle) return handle(url, init, calls);
      if (url === PLAY_TOKEN_URL) return response({ access_token: "test-access-token", expires_in: 3600 });
      if (url.includes("apps:search")) return response({ apps: [{ packageName: "com.example.app", displayName: "Example" }] });
      return response({ releases: [release()] });
    },
    now: () => time,
    ...extra,
  });
  return {
    service, data, keyring, calls,
    tick: ms => { time += ms; },
    protect: value => { protection = value; },
    account: input => service.saveAccount({ name: "Toris", serviceAccountJson: credential, ...input }),
  };
}

test("credentials only enter protected secrets; public views and storage contain no key, email, path, or token", async () => {
  const h = harness();
  const account = await h.account();
  assert.equal(h.keyring.size, 1);
  const stored = JSON.parse([...h.keyring.values()][0]);
  assert.deepEqual(Object.keys(stored).sort(), ["client_email", "private_key", "type"]);
  await h.service.check({ accountId: account.id });
  const visible = JSON.stringify({ list: await h.service.list(), data: [...h.data] });
  for (const hidden of ["PRIVATE KEY", "test@example.iam.gserviceaccount.com", "test-access-token", "malicious.example", "do-not-return-this"]) assert.equal(visible.includes(hidden), false);
  assert.equal((await h.service.list()).accounts[0].hasCredential, true);
});

test("unavailable keyring rejects credentials before storage or network writes", async () => {
  const h = harness(); h.protect("unavailable");
  await assert.rejects(h.account(), error => error.code === "keyring_unavailable");
  assert.equal(h.data.size, 0);
  assert.equal(h.keyring.size, 0);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.service.list()).protection.status, "unavailable");
});

test("JWT uses pinned Google audience/endpoint and valid RS256; only POST is OAuth", async () => {
  const h = harness();
  const account = await h.account({ tracks: ["production"] });
  const checked = await h.service.check({ accountId: account.id });
  assert.equal(checked.apps[0].status, "published");
  const oauth = h.calls.find(call => call.method === "POST");
  assert.equal(oauth.url, PLAY_TOKEN_URL);
  assert.equal(oauth.redirect, "error");
  const assertion = new URLSearchParams(oauth.body).get("assertion");
  const [header, claims, signature] = assertion.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
  const jwt = JSON.parse(Buffer.from(claims, "base64url"));
  assert.equal(jwt.aud, PLAY_TOKEN_URL);
  assert.equal(jwt.exp - jwt.iat, 900);
  assert.match(jwt.scope, /playdeveloperreporting/);
  assert.match(jwt.scope, /androidpublisher/);
  assert.equal(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(pair.publicKey, Buffer.from(signature, "base64url")), true);
  assert.equal(h.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(h.calls.some(call => /edits|upload|promote/.test(call.url)), false);
  assert.equal(h.calls.every(call => call.redirect === "error" && call.signal instanceof AbortSignal), true);
});

test("app discovery paginates, deduplicates apps, and reads custom/form-factor tracks", async () => {
  const h = harness((url) => {
    if (url === PLAY_TOKEN_URL) return response({ access_token: "token", expires_in: 3600 });
    if (url.includes("apps:search")) {
      if (url.includes("pageToken=")) {
        assert.equal(new URL(url).searchParams.get("pageToken"), "page +/2");
        return response({ apps: [{ packageName: "com.example.two", displayName: "Two" }, { packageName: "com.example.one" }] });
      }
      return response({ apps: [{ packageName: "com.example.one", displayName: "One" }], nextPageToken: "page +/2" });
    }
    return response({ releases: [release("IN_REVIEW")] });
  });
  const account = await h.account({ tracks: ["production", "closed-friends", "wear:production"] });
  const result = await h.service.check({ accountId: account.id });
  assert.equal(result.apps.length, 2);
  assert.equal(h.calls.filter(call => call.url.includes("/releases")).length, 6);
  assert.ok(h.calls.some(call => call.url.includes("/tracks/wear%3Aproduction/releases")));
  assert.deepEqual(result.apps[0].tracks.map(track => track.track), ["production", "closed-friends", "wear:production"]);
  assert.equal(result.apps[0].status, "in_review");
  assert.equal(result.discovery.stale, false);
});

test("manual packages remain checkable if reporting discovery is forbidden", async () => {
  const h = harness(url => {
    if (url === PLAY_TOKEN_URL) return response({ access_token: "token", expires_in: 3600 });
    if (url.includes("apps:search")) return response({ error: { message: "secret-server-error" } }, 403);
    return response({ releases: [release()] });
  });
  const account = await h.account({ packages: ["com.manual.app"], tracks: ["production"] });
  const result = await h.service.check({ accountId: account.id });
  assert.equal(result.apps[0].packageName, "com.manual.app");
  assert.equal(result.apps[0].status, "published");
  assert.equal(result.discovery.error.code, "permission");
  assert.equal(result.checkedAt, null);
  assert.equal(JSON.stringify(result).includes("secret-server-error"), false);
});

test("configured packages restrict requests to that allowlist", async () => {
  const h = harness(url => {
    if (url === PLAY_TOKEN_URL) return response({ access_token: "token", expires_in: 3600 });
    if (url.includes("apps:search")) return response({ apps: [{ packageName: "com.keep.app" }, { packageName: "com.unselected.app" }] });
    return response({ releases: [release()] });
  });
  const account = await h.account({ packages: ["com.keep.app", "com.manual.app"], tracks: ["production"] });
  const result = await h.service.check({ accountId: account.id });
  assert.deepEqual(result.apps.map(app => app.packageName), ["com.keep.app", "com.manual.app"]);
  assert.equal(h.calls.some(call => call.url.includes("com.unselected.app")), false);
});

test("failed track keeps the exact previous observation time and data, with stale/error markers", async () => {
  let fail = false;
  const h = harness(url => {
    if (url === PLAY_TOKEN_URL) return response({ access_token: "token", expires_in: 3600 });
    if (url.includes("apps:search")) return response({ apps: [{ packageName: "com.example.app" }] });
    if (fail && url.includes("/production/")) return response({ error: { message: "sensitive provider body" } }, 503);
    return response({ releases: [release(url.includes("/production/") ? "PUBLISHED" : "IN_REVIEW")] });
  });
  const account = await h.account({ tracks: ["production", "internal"] });
  const first = await h.service.check({ accountId: account.id });
  const observed = first.apps[0].tracks[0].observedAt;
  fail = true; h.tick(120000);
  const second = await h.service.check({ accountId: account.id, force: true });
  assert.equal(second.apps[0].tracks[0].observedAt, observed);
  assert.equal(second.apps[0].tracks[0].stale, true);
  assert.equal(second.apps[0].tracks[0].releases[0].state, "published");
  assert.equal(second.apps[0].tracks[0].error.status, 503);
  assert.notEqual(second.apps[0].tracks[1].observedAt, observed);
  assert.equal(second.apps[0].tracks[1].stale, false);
  assert.equal(second.checkedAt, first.checkedAt);
  assert.equal(second.error.code, "partial");
  assert.equal(JSON.stringify(second).includes("sensitive provider body"), false);
});

test("authentication failure never leaks Google response contents and keeps prior observations stale", async () => {
  let fail = false;
  const h = harness(url => {
    if (url === PLAY_TOKEN_URL) return fail ? response({ error_description: privateKey }, 400) : response({ access_token: "token", expires_in: 60 });
    if (url.includes("apps:search")) return response({ apps: [{ packageName: "com.example.app" }] });
    return response({ releases: [release()] });
  });
  const account = await h.account({ tracks: ["production"] });
  const first = await h.service.check({ accountId: account.id });
  fail = true; h.tick(120000);
  const failed = await h.service.check({ accountId: account.id, force: true });
  assert.equal(failed.error.code, "authentication");
  assert.equal(failed.apps[0].tracks[0].observedAt, first.apps[0].tracks[0].observedAt);
  assert.equal(failed.apps[0].tracks[0].stale, true);
  assert.equal(JSON.stringify(failed).includes("PRIVATE KEY"), false);
});

test("429 respects cooldown even with force and retains last-known releases", async () => {
  let fail = false;
  const h = harness(url => {
    if (url === PLAY_TOKEN_URL) return response({ access_token: "token", expires_in: 3600 });
    if (url.includes("apps:search")) return response({ apps: [{ packageName: "com.example.app" }] });
    return fail ? response({ error: "quota" }, 429, { "retry-after": "120" }) : response({ releases: [release()] });
  });
  const account = await h.account({ tracks: ["production"] });
  await h.service.check({ accountId: account.id });
  fail = true; h.tick(1000);
  const limited = await h.service.check({ accountId: account.id, force: true });
  assert.equal(limited.error.code, "rate_limited");
  assert.equal(limited.apps[0].tracks[0].stale, true);
  const count = h.calls.length;
  await h.service.check({ accountId: account.id, force: true });
  assert.equal(h.calls.length, count);
  h.tick(120001); fail = false;
  const recovered = await h.service.check({ accountId: account.id, force: true });
  assert.equal(recovered.apps[0].tracks[0].stale, false);
  assert.equal(recovered.error, null);
});

test("expired account observations are stale when opened; saving metadata does not renew verification", async () => {
  const h = harness();
  const account = await h.account({ tracks: ["production"] });
  const first = await h.service.check({ accountId: account.id });
  h.tick(3600001);
  const opened = await h.service.list();
  assert.equal(opened.accounts[0].apps[0].tracks[0].stale, true);
  assert.equal(opened.accounts[0].apps[0].tracks[0].observedAt, first.apps[0].tracks[0].observedAt);
  const edited = await h.service.saveAccount({ id: account.id, name: "Renamed" });
  assert.equal(edited.checkedAt, null);
  assert.equal(edited.apps[0].tracks[0].stale, true);
});

test("cached checks spend no requests; per-account access tokens are reused and isolated", async () => {
  const h = harness();
  const a = await h.account({ name: "Toris", tracks: ["production"] });
  const b = await h.account({ name: "Another", tracks: ["internal"] });
  await h.service.check({ accountId: a.id });
  const count = h.calls.length;
  await h.service.check({ accountId: a.id });
  assert.equal(h.calls.length, count);
  await h.service.check({ accountId: a.id, force: true });
  assert.equal(h.calls.filter(call => call.url === PLAY_TOKEN_URL).length, 1);
  await h.service.check({ accountId: b.id });
  assert.equal(h.calls.filter(call => call.url === PLAY_TOKEN_URL).length, 2);
  assert.equal((await h.service.list()).accounts.length, 2);
});

test("concurrency stays at three across accounts and duplicate checks share work", async () => {
  let active = 0, high = 0;
  const h = harness(async url => {
    active++; high = Math.max(high, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    if (url === PLAY_TOKEN_URL) return response({ access_token: "token", expires_in: 3600 });
    if (url.includes("apps:search")) return response({ apps: ["one", "two", "three"].map(name => ({ packageName: `com.example.${name}` })) });
    return response({ releases: [release()] });
  });
  const a = await h.account(), b = await h.account({ name: "Second" });
  const [one, again] = await Promise.all([
    h.service.check({ accountId: a.id }), h.service.check({ accountId: a.id }),
    h.service.check({ accountId: b.id }),
  ]);
  assert.deepEqual(one, again);
  assert.ok(high <= 3, `observed ${high} concurrent requests`);
  assert.equal(h.calls.filter(call => call.url.includes("/releases")).length, 3 * DEFAULT_TRACKS.length * 2);
});

test("malformed/repeated app pagination is bounded and falls back to manual packages", async () => {
  const h = harness(url => {
    if (url === PLAY_TOKEN_URL) return response({ access_token: "token", expires_in: 3600 });
    if (url.includes("apps:search")) return response({ apps: [], nextPageToken: "same-page" });
    return response({ releases: [release()] });
  });
  const a = await h.account({ packages: ["com.manual.app"], tracks: ["production"] });
  const result = await h.service.check({ accountId: a.id });
  assert.equal(result.discovery.error.code, "pagination");
  assert.equal(h.calls.filter(call => call.url.includes("apps:search")).length, 2);
  assert.equal(result.apps[0].packageName, "com.manual.app");
});

test("404 and malformed release data are unknown, not a successful empty release", async () => {
  const h = harness(url => {
    if (url === PLAY_TOKEN_URL) return response({ access_token: "token", expires_in: 3600 });
    if (url.includes("apps:search")) return response({ apps: [{ packageName: "com.example.app" }] });
    if (url.includes("/production/")) return response({}, 404);
    return response({ releases: "wrong" });
  });
  const a = await h.account({ tracks: ["production", "internal"] });
  const result = await h.service.check({ accountId: a.id });
  assert.equal(result.apps[0].status, "unknown");
  assert.equal(result.apps[0].tracks[0].error.code, "not_found");
  assert.equal(result.apps[0].tracks[1].error.code, "invalid_response");
});

test("network failures are sanitized and do not call any mutation endpoint", async () => {
  const h = harness(() => { throw new Error(privateKey); });
  const a = await h.account();
  const result = await h.service.check({ accountId: a.id });
  assert.equal(result.error.code, "network");
  assert.equal(JSON.stringify(result).includes("PRIVATE KEY"), false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, PLAY_TOKEN_URL);
});

test("input validation rejects malformed credentials/paths/packages/tracks without revealing supplied values", async () => {
  const h = harness();
  await assert.rejects(h.account({ serviceAccountJson: '{"private_key":"secret-input' }), error => error.code === "invalid_credential" && !error.message.includes("secret-input"));
  await assert.rejects(h.account({ tracks: ["../../edits"] }), error => error.code === "invalid_input");
  await assert.rejects(h.account({ packages: ["com.example.app?access_token=secret"] }), error => error.code === "invalid_input");
  await assert.rejects(h.account({ tracks: [] }), error => error.code === "invalid_input");
  await assert.rejects(h.account({ credentialPath: "/path/to/secret.json" }), error => error.code === "invalid_input");
  assert.equal(h.keyring.size, 0);
  assert.equal(h.calls.length, 0);
});

test("selected credential file is read once, then only encrypted JSON is retained", async () => {
  let reads = 0;
  const h = harness(null, { readCredentialFile: async path => { reads++; assert.match(path, /chosen-key\.json$/); return credential; } });
  const a = await h.service.saveAccount({ name: "From file", credentialPath: "~/chosen-key.json", tracks: ["production"] });
  await h.service.check({ accountId: a.id });
  assert.equal(reads, 1);
  assert.equal(JSON.stringify([...h.data]).includes("chosen-key"), false);
});

test("removing one account removes its credential/cache and leaves other accounts intact", async () => {
  const h = harness();
  const a = await h.account(), b = await h.account({ name: "Second" });
  await h.service.check({ accountId: a.id });
  assert.deepEqual(await h.service.removeAccount({ accountId: a.id }), { removed: a.id });
  assert.equal(h.keyring.size, 1);
  const list = await h.service.list();
  assert.deepEqual(list.accounts.map(account => account.id), [b.id]);
  assert.equal(h.data.get(PLAY_STORAGE_KEY).accounts.length, 1);
  await assert.rejects(h.service.check({ accountId: a.id }), error => error.code === "not_found");
});

test("status gives review/rejection priority while retaining published flag; newer approved release supersedes rejection", () => {
  const track = (name, releases) => ({ track: name, releases, observedAt: "2026-11-19", stale: false, error: null });
  const r = (state, code) => ({ name: state, state, versionCodes: [code] });
  const rejected = summarizeApp([track("production", [r("published", 1), r("not_approved", 2)])]);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.published, true);
  const superseded = summarizeApp([track("production", [r("not_approved", 2), r("published", 3)])]);
  assert.equal(superseded.status, "published");
  assert.equal(superseded.needsAttention, false);
  assert.equal(summarizeApp([track("internal", [r("published", 2)])]).status, "testing");
  assert.equal(summarizeApp([track("production", [])]).status, "no_release");
  assert.equal(summarizeApp([track("production", [r("in_review", 4)])]).status, "in_review");
});
