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
  return r.access_token;
}
async function fetchProfile(mcToken) {
  const r = await fetch(PROFILE, { headers: { Authorization: "Bearer " + mcToken } });
  if (r.status === 404) throw new Error("This Microsoft account doesn't own Minecraft: Java Edition.");
  if (!r.ok) throw new Error("Couldn't read the Minecraft profile (" + r.status + ").");
  return r.json();
}

// Poll until the user finishes the browser sign-in, then complete the full chain.
async function completeSignIn(device) {
  const msa = await pollToken(device);
  const xblRes = await authenticateXBL(msa.access_token);
  const xstsRes = await xsts(xblRes.token);
  const mcToken = await minecraftLogin(xstsRes.uhs, xstsRes.token);
  const prof = await fetchProfile(mcToken);
  const uuid = prof.id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
  saveAccount({ name: prof.name, uuid, accessToken: mcToken, refreshToken: msa.refresh_token, userType: "msa" });
  return { name: prof.name, uuid };
}

function currentSession() {
  const a = loadAccount();
  return a ? { name: a.name, uuid: a.uuid, accessToken: a.accessToken, userType: "msa", offline: false } : null;
}
function account() {
  const a = loadAccount();
  return a ? { name: a.name, uuid: a.uuid } : null;
}

module.exports = { init, startDeviceCode, completeSignIn, currentSession, account, signOut };
