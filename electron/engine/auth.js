// Microsoft sign-in (MSA device-code → Xbox Live → XSTS → Minecraft → profile).
// Mirrors LodestoneCore's auth chain, incl. the legacy live.com client id that
// sidesteps the Azure approval gate. Pure HTTP — identical on Windows/macOS.
const fs = require("fs");
const path = require("path");

const CLIENT_ID = "00000000402b5328";
const SCOPE = "service::user.auth.xboxlive.com::MBI_SSL";
const DEVICE_URL = "https://login.live.com/oauth20_connect.srf";
const TOKEN_URL = "https://login.live.com/oauth20_token.srf";
const XBL_URL = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_LOGIN = "https://api.minecraftservices.com/authentication/login_with_xbox";
const PROFILE = "https://api.minecraftservices.com/minecraft/profile";

let DATA_DIR = null;
function init(dir) { DATA_DIR = dir; }
const acctFile = () => path.join(DATA_DIR, "account.json");
function loadAccount() { try { return JSON.parse(fs.readFileSync(acctFile(), "utf8")); } catch { return null; } }
function saveAccount(a) { fs.writeFileSync(acctFile(), JSON.stringify(a, null, 2)); }
function signOut() { try { fs.unlinkSync(acctFile()); } catch {} return true; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function form(url, fields) {
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  let json = {}; try { json = JSON.parse(await r.text()); } catch {}
  return { status: r.status, json };
}
async function postJSON(url, obj) {
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(obj),
  });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  if (!r.ok) { const e = new Error(`${url} → ${r.status}`); e.status = r.status; e.body = text; throw e; }
  return json;
}

async function startDeviceCode() {
  const { json } = await form(DEVICE_URL, { client_id: CLIENT_ID, scope: SCOPE, response_type: "device_code" });
  if (!json.device_code) throw new Error("Couldn't start Microsoft sign-in.");
  return {
    deviceCode: json.device_code, userCode: json.user_code,
    verificationUri: json.verification_uri || "https://www.microsoft.com/link",
    interval: json.interval || 5, expiresIn: json.expires_in || 900,
  };
}

async function pollToken(device) {
  const deadline = Date.now() + device.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep((device.interval || 5) * 1000);
    const { status, json } = await form(TOKEN_URL, {
      client_id: CLIENT_ID, device_code: device.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (status === 200 && json.access_token) return json;
    if (json.error && json.error !== "authorization_pending" && json.error !== "slow_down") {
      throw new Error(json.error_description || json.error);
    }
  }
  throw new Error("Sign-in timed out — please try again.");
}

async function xbl(rps) {
  const r = await postJSON(XBL_URL, {
    Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: rps },
    RelyingParty: "http://auth.xboxlive.com", TokenType: "JWT",
  });
  return { token: r.Token, uhs: r.DisplayClaims.xui[0].uhs };
}
async function authenticateXBL(token) {
  try { return await xbl(token); }
  catch (e) { if (e.status === 400 || e.status === 401) return await xbl("d=" + token); throw e; }
}
async function xsts(xblToken) {
  try {
    const r = await postJSON(XSTS_URL, {
      Properties: { SandboxId: "RETAIL", UserTokens: [xblToken] },
      RelyingParty: "rp://api.minecraftservices.com/", TokenType: "JWT",
    });
    return { token: r.Token, uhs: r.DisplayClaims.xui[0].uhs };
  } catch (e) {
    if (e.status === 401) {
      let xerr; try { xerr = JSON.parse(e.body).XErr; } catch {}
      if (xerr === 2148916233) throw new Error("This account has no Xbox profile. Sign in once at xbox.com, then retry.");
      if (xerr === 2148916238) throw new Error("Child account — add it to a Microsoft Family to continue.");
      throw new Error("Xbox sign-in failed (XSTS).");
    }
    throw e;
  }
}
async function minecraftLogin(uhs, xstsToken) {
  const r = await postJSON(MC_LOGIN, { identityToken: `XBL3.0 x=${uhs};${xstsToken}` });
  return { token: r.access_token, expiresIn: Number(r.expires_in) || 86400 };
}
async function fetchProfile(mcToken) {
  const r = await fetch(PROFILE, { headers: { Authorization: "Bearer " + mcToken } });
  if (r.status === 404) throw new Error("This Microsoft account doesn't own Minecraft: Java Edition.");
  if (!r.ok) throw new Error("Couldn't read the Minecraft profile (" + r.status + ").");
  return r.json();
}

// MSA access token → Xbox Live → XSTS → Minecraft token → profile. Shared by the
// initial device-code sign-in and the launch-time refresh (mirrors the Mac
// AuthService's single chain). Returns the fields to persist on the account.
async function sessionFromMsa(msaAccessToken) {
  const xblRes = await authenticateXBL(msaAccessToken);
  const xstsRes = await xsts(xblRes.token);
  const mc = await minecraftLogin(xstsRes.uhs, xstsRes.token);
  const prof = await fetchProfile(mc.token);
  const uuid = prof.id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
  return {
    name: prof.name, uuid,
    accessToken: mc.token,
    accessTokenExpiresAt: Date.now() + mc.expiresIn * 1000,
  };
}

// Poll until the user finishes the browser sign-in, then complete the full chain.
async function completeSignIn(device) {
  const msa = await pollToken(device);
  const fresh = await sessionFromMsa(msa.access_token);
  saveAccount({ ...fresh, refreshToken: msa.refresh_token, userType: "msa" });
  return { name: fresh.name, uuid: fresh.uuid };
}

// The Minecraft token is good for ~24h; treat it as stale inside a 5-minute margin
// (same margin the Mac app uses) so a launch never hands the game a dying token.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
function tokenFresh(a) {
  return !!(a && a.accessToken && a.accessTokenExpiresAt &&
    a.accessTokenExpiresAt - Date.now() > EXPIRY_MARGIN_MS);
}

// Mint a fresh session from the stored refresh token: refresh_token grant against
// the MSA token endpoint (live.com requires the scope on refresh too), then the
// same Xbox chain as sign-in. Persists the rotated refresh token + new expiry.
// Throws { needsSignIn: true } only on a definitive OAuth rejection (revoked /
// expired refresh token) — that flags the account file but never deletes it, so a
// transient network failure can't sign the user out.
async function refreshSession(a) {
  const { status, json } = await form(TOKEN_URL, {
    client_id: CLIENT_ID, scope: SCOPE,
    refresh_token: a.refreshToken, grant_type: "refresh_token",
  });
  if (status === 200 && json.access_token) {
    const fresh = await sessionFromMsa(json.access_token);
    const updated = {
      ...a, ...fresh,
      refreshToken: json.refresh_token || a.refreshToken,   // rotate when Microsoft rotates
      userType: "msa",
    };
    delete updated.needsSignIn;
    saveAccount(updated);
    return updated;
  }
  if (status >= 400 && status < 500 && json && json.error) {
    saveAccount({ ...a, needsSignIn: true });   // keep the file — the UI shows who to re-sign-in
    const e = new Error("Your Microsoft session expired — please sign in again.");
    e.needsSignIn = true;
    throw e;
  }
  const e = new Error(`Token refresh failed (${status || "network"}).`);
  e.transient = true;
  throw e;
}

// Launch-ready session. Fast path: the cached Minecraft token while it's still
// valid — zero network. Slow path: refresh the whole chain once, then cache it.
// Returns null (never throws) when there's no way to an online session; the
// account file survives so the user can retry or re-sign-in.
async function currentSession() {
  const a = loadAccount();
  if (!a) return null;
  if (tokenFresh(a)) {
    return { name: a.name, uuid: a.uuid, accessToken: a.accessToken, userType: "msa", offline: false };
  }
  if (!a.refreshToken) return null;   // pre-refresh account shape with a dead token
  try {
    const u = await refreshSession(a);
    return { name: u.name, uuid: u.uuid, accessToken: u.accessToken, userType: "msa", offline: false };
  } catch {
    return null;   // revoked → account flagged needsSignIn; transient → file untouched
  }
}
function account() {
  const a = loadAccount();
  return a ? { name: a.name, uuid: a.uuid, needsSignIn: !!a.needsSignIn } : null;
}

module.exports = { init, startDeviceCode, completeSignIn, currentSession, account, signOut };
