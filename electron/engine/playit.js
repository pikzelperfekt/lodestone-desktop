// playit.gg tunnel agent.
//
// Makes a self-hosted server reachable from anywhere with no port forwarding and
// no router changes: the agent dials out to playit's edge and gets handed a
// public address that forwards back to your local server.
//
// Lodestone drives the OFFICIAL playit agent rather than reimplementing the
// protocol — it isn't a plain TCP relay, and a half-built client would fail in
// ways that look like a broken server. Same shape as the Mac side, which shells
// out to the brew-installed CLI; here we look for playit on PATH or in the usual
// Windows install locations, and point at the download when it's absent.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

let proc = null;
let publicAddress = null;
let statusText = null;
let emit = () => {};

function setEmitter(fn) { emit = fn || (() => {}); }

// Where playit lands on each platform. PATH first, because someone who installed
// it deliberately (winget, brew, cargo) should win over a stale bundled copy.
function candidates() {
  const exe = process.platform === "win32" ? "playit.exe" : "playit";
  const list = [];
  const PATH = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of PATH) list.push(path.join(dir, exe));
  if (process.platform === "win32") {
    const pf = process.env["ProgramFiles"] || "C:\\Program Files";
    const local = process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local");
    list.push(path.join(pf, "playit_gg", exe), path.join(pf, "playit", exe), path.join(local, "playit", exe));
  } else {
    list.push("/opt/homebrew/bin/playit", "/usr/local/bin/playit", "/usr/bin/playit");
  }
  return list;
}

function binaryPath() {
  for (const p of candidates()) {
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* unreadable entry */ }
  }
  return null;
}

function installed() { return !!binaryPath(); }

// playit prints its assigned address on stdout as it connects. The tunnel host
// looks like "something.craft.ply.gg" or "...playit.gg", optionally with a port.
const ADDRESS_RE = /\b([a-z0-9-]+\.(?:[a-z0-9-]+\.)*(?:ply\.gg|playit\.gg)(?::\d+)?)\b/i;

function noteLine(line) {
  const hit = ADDRESS_RE.exec(String(line));
  if (hit && hit[1] !== publicAddress) {
    publicAddress = hit[1];
    emit("playit:state", status());
  }
  emit("playit:log", { line: String(line) });
}

function status() {
  return {
    installed: installed(),
    running: !!proc,
    publicAddress,
    statusText,
    binary: binaryPath(),
  };
}

function start(secret) {
  if (proc) return status();
  const bin = binaryPath();
  if (!bin) throw new Error("The playit agent isn't installed yet — install it, then come back.");
  if (!secret) throw new Error("Save your playit secret key first.");

  publicAddress = null;
  statusText = "Connecting…";
  // --secret keeps the key out of any config file playit would otherwise write.
  proc = spawn(bin, ["--secret", String(secret), "start"], { stdio: ["ignore", "pipe", "pipe"] });

  const onData = (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach(noteLine);
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);

  proc.on("error", (e) => {
    statusText = "Couldn't run the playit agent: " + e.message;
    proc = null;
    emit("playit:state", status());
  });
  proc.on("close", (code) => {
    proc = null;
    publicAddress = null;
    // Code 0 is a clean stop we asked for; anything else is worth surfacing.
    statusText = code === 0 || code === null ? null : `The playit agent exited (code ${code}).`;
    emit("playit:state", status());
  });

  emit("playit:state", status());
  return status();
}

function stop() {
  if (proc) {
    try { proc.kill(); } catch { /* already gone */ }
    proc = null;
  }
  publicAddress = null;
  statusText = null;
  emit("playit:state", status());
  return status();
}

module.exports = { start, stop, status, installed, binaryPath, setEmitter, noteLine, ADDRESS_RE };
