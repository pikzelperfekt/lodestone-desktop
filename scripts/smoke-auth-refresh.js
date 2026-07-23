// [wave0] Smoke test — MSA token refresh at launch (engine/auth.js), headless.
// Fakes the HTTP layer by intercepting global fetch, so no network is touched.
// Run: node scripts/smoke-auth-refresh.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const auth = require("../electron/engine/auth");

const TOKEN_URL = "https://login.live.com/oauth20_token.srf";
const XBL_URL = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_LOGIN = "https://api.minecraftservices.com/authentication/login_with_xbox";
const PROFILE = "https://api.minecraftservices.com/minecraft/profile";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lodestone-auth-"));
auth.init(dir);
const acctFile = path.join(dir, "account.json");

function writeAccount(a) { fs.writeFileSync(acctFile, JSON.stringify(a, null, 2)); }
function readAccount() { return JSON.parse(fs.readFileSync(acctFile, "utf8")); }

const expiredAccount = () => ({
  name: "KingEstel", uuid: "11111111-2222-3333-4444-555555555555",
  accessToken: "mc-stale", accessTokenExpiresAt: Date.now() - 1000,
  refreshToken: "refresh-old", userType: "msa",
});

// Minimal fetch-Response fake (auth.js uses status/ok/text()/json()).
const resp = (status, body) => ({
  status, ok: status >= 200 && status < 300,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  json: async () => body,
});

let calls = [];
const realFetch = globalThis.fetch;
function fakeFetch(routes) {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, body: (opts && opts.body) || "" });
    const route = routes[u];
    if (!route) throw new Error("unexpected fetch " + u);
    return typeof route === "function" ? route(opts) : route;
  };
}

const happyChain = {
  [XBL_URL]: resp(200, { Token: "xbl-tok", DisplayClaims: { xui: [{ uhs: "UHS1" }] } }),
  [XSTS_URL]: resp(200, { Token: "xsts-tok", DisplayClaims: { xui: [{ uhs: "UHS1" }] } }),
  [MC_LOGIN]: resp(200, { access_token: "mc-fresh", expires_in: 86400 }),
  [PROFILE]: resp(200, { id: "11111111222233334444555555555555", name: "KingEstel" }),
};

(async () => {
  // 1) Expired token → refresh grant → full chain → fresh session + rotated refresh token persisted.
  writeAccount(expiredAccount());
  fakeFetch({
    [TOKEN_URL]: resp(200, { access_token: "msa-fresh", refresh_token: "refresh-rotated", expires_in: 3600 }),
    ...happyChain,
  });
  let s = await auth.currentSession();
  assert.ok(s && !s.offline, "expired: expected an online session");
  assert.strictEqual(s.accessToken, "mc-fresh", "expired: session must carry the refreshed MC token");
  assert.deepStrictEqual(
    calls.map((c) => c.url),
    [TOKEN_URL, XBL_URL, XSTS_URL, MC_LOGIN, PROFILE],
    "expired: refresh chain must run token→XBL→XSTS→MC→profile"
  );
  assert.match(calls[0].body, /grant_type=refresh_token/, "expired: must use the refresh_token grant");
  assert.match(calls[0].body, /refresh_token=refresh-old/, "expired: must send the stored refresh token");
  assert.match(calls[0].body, /scope=/, "expired: live.com refresh requires the scope param");
  let a = readAccount();
  assert.strictEqual(a.refreshToken, "refresh-rotated", "expired: rotated refresh token must be persisted");
  assert.strictEqual(a.accessToken, "mc-fresh", "expired: new MC token must be persisted");
  assert.ok(a.accessTokenExpiresAt > Date.now() + 3600 * 1000, "expired: expiry timestamp must be persisted");
  console.log("PASS  expired token → refresh chain → new session + rotated refresh token persisted");

  // 2) Fresh token → zero network, cached session returned.
  fakeFetch({});   // any fetch would throw "unexpected fetch"
  s = await auth.currentSession();
  assert.strictEqual(s.accessToken, "mc-fresh", "fresh: cached token expected");
  assert.strictEqual(calls.length, 0, "fresh: no network calls allowed");
  console.log("PASS  fresh token → cached session, zero network");

  // 3) Refresh 400 (revoked) → clean needs-sign-in: null session, file kept + flagged.
  writeAccount(expiredAccount());
  fakeFetch({ [TOKEN_URL]: resp(400, { error: "invalid_grant" }) });
  s = await auth.currentSession();
  assert.strictEqual(s, null, "revoked: session must be null (needs sign-in), not a crash");
  a = readAccount();   // throws if the account file was deleted
  assert.strictEqual(a.needsSignIn, true, "revoked: account must be flagged needsSignIn");
  assert.strictEqual(a.name, "KingEstel", "revoked: account identity preserved");
  assert.strictEqual(auth.account().needsSignIn, true, "revoked: account() surfaces needsSignIn");
  console.log("PASS  refresh 400 → null session, account kept + flagged needsSignIn");

  // 4) Transient network error → null session, account file untouched (no flag, no delete).
  writeAccount(expiredAccount());
  fakeFetch({ [TOKEN_URL]: () => { throw new Error("ECONNRESET"); } });
  s = await auth.currentSession();
  assert.strictEqual(s, null, "transient: session must be null, not a crash");
  a = readAccount();
  assert.strictEqual(a.needsSignIn, undefined, "transient: must NOT flag needsSignIn");
  assert.strictEqual(a.refreshToken, "refresh-old", "transient: refresh token untouched");
  console.log("PASS  transient network error → null session, account file untouched");

  // 5) Refresh 200 but a chain hop dies (e.g. XBL down) → transient too: no flag, no delete.
  writeAccount(expiredAccount());
  fakeFetch({
    [TOKEN_URL]: resp(200, { access_token: "msa-fresh", refresh_token: "refresh-rotated2", expires_in: 3600 }),
    [XBL_URL]: resp(500, {}),
  });
  s = await auth.currentSession();
  assert.strictEqual(s, null, "chain-fail: session must be null");
  a = readAccount();
  assert.strictEqual(a.refreshToken, "refresh-old", "chain-fail: nothing persisted on a half-run chain");
  assert.strictEqual(a.needsSignIn, undefined, "chain-fail: must NOT flag needsSignIn");
  console.log("PASS  mid-chain failure → null session, nothing persisted");

  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("\nAll auth-refresh smoke checks passed.");
})().catch((e) => { globalThis.fetch = realFetch; console.error("FAIL:", e.message); process.exit(1); });
