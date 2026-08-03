// Client for the exaroton API (api.exaroton.com/v1) — on-demand cloud Minecraft
// servers you control from inside Lodestone: start, stop, restart, console, and
// pushing an instance's mods up to them. Pay-per-use, billed by the minute while
// the server is actually up.
//
// Ported from LodestoneCore/Hosting/ExarotonService.swift so both clients speak
// the same API and a token pasted on either one behaves identically.
//
// exaroton wraps EVERY response as { success, error, data } — including failures
// that still arrive with HTTP 200 — so the envelope must be unwrapped rather than
// trusting the status code.
const fs = require("fs");
const path = require("path");

const BASE = "https://api.exaroton.com/v1";

// exaroton status codes -> the label the UI shows.
const STATUS = {
  0: "Offline", 1: "Online", 2: "Starting", 3: "Stopping", 4: "Restarting",
  5: "Saving", 6: "Loading", 7: "Crashed", 8: "Pending", 10: "Preparing",
};
const BUSY = new Set([2, 3, 4, 5, 6, 8, 10]);

function decorate(server) {
  if (!server) return server;
  const status = Number(server.status);
  return {
    ...server,
    statusLabel: STATUS[status] || "Offline",
    isOnline: status === 1,
    isBusy: BUSY.has(status),
  };
}

function headers(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, "User-Agent": "Lodestone", ...extra };
}

async function request(token, endpoint, { method = "GET", body } = {}) {
  if (!token) throw new Error("Connect your exaroton account first.");
  const opts = { method, headers: headers(token) };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${BASE}/${endpoint}`, opts);
  // 401 gets its own wording — a rejected token is the one failure a user can
  // actually fix, and "request failed" would send them looking in the wrong place.
  if (res.status === 401) throw new Error("That exaroton token was rejected. Check it and try again.");

  let env = null;
  try { env = await res.json(); } catch { /* non-JSON body handled below */ }
  if (!env) throw new Error(`exaroton request failed (HTTP ${res.status}).`);
  if (!env.success) throw new Error(env.error || "exaroton request failed.");
  return env.data;
}

async function account(token) { return request(token, "account/"); }

async function servers(token) {
  const list = await request(token, "servers/");
  return (Array.isArray(list) ? list : []).map(decorate);
}

async function server(token, id) { return decorate(await request(token, `servers/${id}`)); }

async function start(token, id) { await request(token, `servers/${id}/start/`); return true; }
async function stop(token, id) { await request(token, `servers/${id}/stop/`); return true; }
async function restart(token, id) { await request(token, `servers/${id}/restart/`); return true; }

async function command(token, id, cmd) {
  await request(token, `servers/${id}/command/`, { method: "POST", body: { command: String(cmd) } });
  return true;
}

// The server's whole latest.log. exaroton returns all of it, so the caller keeps
// the tail; empty while the server is offline.
async function logs(token, id, tailLines = 400) {
  const data = await request(token, `servers/${id}/logs/`);
  const content = (data && data.content) || "";
  const lines = content.split(/\r?\n/);
  return lines.slice(-tailLines).join("\n");
}

// PUT a file into the server's data directory, e.g. "mods/sodium.jar".
// Slashes stay directory separators; each segment is encoded on its own.
async function uploadFile(token, id, relPath, buffer) {
  const encoded = String(relPath).split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const res = await fetch(`${BASE}/servers/${id}/files/data/${encoded}`, {
    method: "PUT",
    headers: headers(token, { "Content-Type": "application/octet-stream" }),
    body: buffer,
  });
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json()).error || ""; } catch { /* empty body */ }
    throw new Error(msg || `Upload failed (HTTP ${res.status}).`);
  }
  return true;
}

// Push an instance's mods to a server.
//
// Client-only mods are deliberately excluded: Sodium, shaders and minimaps
// either crash a dedicated server or do nothing on it, and uploading them is how
// you end up debugging a server that won't boot.
async function pushMods({ token, serverId, modsDir, clientOnly = [], onLog } = {}) {
  const skipSet = new Set(clientOnly);
  let all = [];
  try { all = fs.readdirSync(modsDir).filter((f) => /\.jar$/i.test(f)); } catch { all = []; }
  const jars = all.filter((f) => !skipSet.has(f));
  const skipped = all.length - jars.length;
  if (!jars.length) throw new Error("That instance has no server-side mod jars to upload.");

  let ok = 0;
  let lastError = null;
  for (const jar of jars) {
    try {
      onLog && onLog(`Uploading ${jar}…`);
      await uploadFile(token, serverId, `mods/${jar}`, fs.readFileSync(path.join(modsDir, jar)));
      ok++;
    } catch (e) { lastError = e.message; }
  }
  const skipNote = skipped > 0 ? ` Skipped ${skipped} client-only mod${skipped === 1 ? "" : "s"}.` : "";
  return {
    uploaded: ok, total: jars.length, skipped, error: lastError,
    message: `Uploaded ${ok}/${jars.length} mods.${skipNote} Set the server's software on exaroton, then start it.`,
  };
}

module.exports = {
  account, servers, server, start, stop, restart, command, logs, uploadFile, pushMods,
  decorate, STATUS,
};
