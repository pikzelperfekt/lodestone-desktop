// The Lodestone "engine" — a cross-platform Node stand-in for the Swift sidecar.
// Real install + launch + Microsoft auth; persists to the per-user app-data dir.
const fs = require("fs");
const path = require("path");
const os = require("os");
const platform = require("./platform");
const install = require("./install");
const loaders = require("./loaders");
const content = require("./content");
const worlds = require("./worlds");
const auth = require("./auth");
const { launch: doLaunch, offlineSession } = require("./launch");

let DATA_DIR = null;
let emit = () => {};
const running = {}; // instanceId -> child process

function init(userDataPath) {
  DATA_DIR = userDataPath || path.join(os.homedir(), ".lodestone");
  fs.mkdirSync(path.join(DATA_DIR, "instances"), { recursive: true });
  auth.init(DATA_DIR);
}
function setEmitter(fn) { emit = fn || (() => {}); }
function dataDir() { return DATA_DIR; }

function info() {
  return {
    platform: platform.PLATFORM, arch: platform.ARCH, engine: "node-engine",
    electron: process.versions.electron, dataDir: DATA_DIR,
  };
}

// ---- Instance store ----
const instancesFile = () => path.join(DATA_DIR, "instances.json");
function readInstances() { try { return JSON.parse(fs.readFileSync(instancesFile(), "utf8")); } catch { return []; } }
function writeInstances(list) { fs.writeFileSync(instancesFile(), JSON.stringify(list, null, 2)); }
function listInstances() { return readInstances().sort((a, b) => (b.lastPlayed || b.created) - (a.lastPlayed || a.created)); }

const ACCENTS = { fabric: "#B57BE6", quilt: "#7BC6E6", neoforge: "#E08A3C", forge: "#D4644A", vanilla: "#5EE6A0" };

function createInstance({ name, mcVersion, loader }) {
  if (!mcVersion) throw new Error("Pick a Minecraft version.");
  const list = readInstances();
  const id = Math.random().toString(16).slice(2, 14);
  const ldr = loader || "vanilla";
  const inst = {
    id, name: (name && name.trim()) || (ldr === "vanilla" ? "Vanilla" : ldr[0].toUpperCase() + ldr.slice(1)),
    mcVersion, loader: ldr, accent: ACCENTS[ldr] || ACCENTS.vanilla,
    ramMB: ldr === "vanilla" ? null : Math.min(12288, Math.max(4096, Math.round(os.totalmem() / 1048576) - 2048)),
    mods: 0, content: [], created: Date.now(), lastPlayed: null,
  };
  fs.mkdirSync(path.join(DATA_DIR, "instances", id), { recursive: true });
  list.unshift(inst); writeInstances(list);
  return inst;
}
function deleteInstance(id) {
  if (running[id]) throw new Error("Stop the instance before deleting it.");
  writeInstances(readInstances().filter((i) => i.id !== id));
  try { fs.rmSync(path.join(DATA_DIR, "instances", id), { recursive: true, force: true }); } catch {}
  return true;
}
// Edit the mutable fields of an instance in place and persist. Only the keys that are
// supplied are touched; ramMB "" / 0 clears back to the auto default, javaArgs is free
// text appended to the JVM args at launch.
function updateInstance({ id, name, ramMB, javaArgs, mcVersion }) {
  const list = readInstances();
  const inst = list.find((i) => i.id === id);
  if (!inst) throw new Error("Instance not found.");
  if (name !== undefined) { const n = String(name).trim(); if (n) inst.name = n; }
  if (ramMB !== undefined) { const n = Number(ramMB); inst.ramMB = Number.isFinite(n) && n > 0 ? Math.round(n) : null; }
  if (javaArgs !== undefined) inst.javaArgs = String(javaArgs).trim();
  if (mcVersion !== undefined) { const v = String(mcVersion).trim(); if (v) inst.mcVersion = v; }
  writeInstances(list);
  return inst;
}

// ---- Mojang versions ----
const MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
let versionCache = null;
async function listVersions() {
  if (versionCache) return versionCache;
  const res = await fetch(MANIFEST);
  if (!res.ok) throw new Error(`Mojang manifest ${res.status}`);
  const json = await res.json();
  versionCache = { releases: json.versions.filter((v) => v.type === "release").map((v) => v.id), latest: json.latest.release };
  return versionCache;
}

// ---- Modrinth search ----
async function modrinthSearch({ query, type, loader, mc }) {
  const facets = [[`project_type:${type || "mod"}`]];
  if ((type || "mod") === "mod" && loader && loader !== "vanilla") facets.push([`categories:${loader}`]);
  if ((type || "mod") !== "modpack" && mc) facets.push([`versions:${mc}`]);
  const url = new URL("https://api.modrinth.com/v2/search");
  url.searchParams.set("query", query || ""); url.searchParams.set("limit", "30");
  url.searchParams.set("facets", JSON.stringify(facets));
  const res = await fetch(url, { headers: { "User-Agent": "Lodestone/0.1 (prototype)" } });
  if (!res.ok) throw new Error(`Modrinth ${res.status}`);
  const json = await res.json();
  return json.hits.map((h) => ({ id: h.project_id, title: h.title, author: h.author, description: h.description, downloads: h.downloads, icon: h.icon_url, type: h.project_type }));
}

// ---- Content (mods / resource packs / shaders) ----
async function installContent({ instanceId, projectId, versionId }) {
  const list = readInstances();
  const inst = list.find((i) => i.id === instanceId);
  if (!inst) throw new Error("Instance not found.");
  const records = await content.install({
    dataDir: DATA_DIR, instance: inst, projectId, versionId,
    onLog: (m) => emit("content:log", { instanceId, line: m }),
  });
  inst.content = inst.content || [];
  for (const r of records) {
    const existing = inst.content.findIndex((c) => c.projectId === r.projectId);
    if (existing >= 0) inst.content[existing] = r; else inst.content.push(r);   // upgrade-in-place or add
  }
  inst.mods = inst.content.filter((c) => c.kind === "mod").length;
  writeInstances(list);
  return { installed: records, content: inst.content };
}
function listContent(instanceId) {
  const inst = readInstances().find((i) => i.id === instanceId);
  return (inst && inst.content) || [];
}
function removeContent({ instanceId, projectId }) {
  const list = readInstances();
  const inst = list.find((i) => i.id === instanceId);
  if (!inst || !inst.content) return false;
  const item = inst.content.find((c) => c.projectId === projectId);
  if (item) content.remove({ dataDir: DATA_DIR, instance: inst, fileName: item.fileName, kind: item.kind });
  inst.content = inst.content.filter((c) => c.projectId !== projectId);
  inst.mods = inst.content.filter((c) => c.kind === "mod").length;
  writeInstances(list);
  return true;
}

// ---- Worlds (singleplayer saves per instance) ----
function worldList(instanceId) { return worlds.list(DATA_DIR, instanceId); }
function worldBackups(instanceId) { return worlds.backups(DATA_DIR, instanceId); }
function worldBackup({ instanceId, world }) { return worlds.backup(DATA_DIR, instanceId, world); }
function worldRestore({ instanceId, backup }) { return worlds.restore(DATA_DIR, instanceId, backup); }
function worldRename({ instanceId, world, name }) { return worlds.rename(DATA_DIR, instanceId, world, name); }
function worldRemove({ instanceId, world }) { return worlds.remove(DATA_DIR, instanceId, world); }

// ---- Account / sign-in ----
function account() { return auth.account(); }
function signOut() { return auth.signOut(); }
async function signInStart() { return auth.startDeviceCode(); }       // → {userCode, verificationUri, deviceCode, interval, expiresIn}
async function signInComplete(device) { return auth.completeSignIn(device); }

// ---- Launch (real) ----
async function launch(id) {
  const inst = readInstances().find((i) => i.id === id);
  if (!inst) throw new Error("Instance not found.");
  if (running[id]) return { started: true, message: "Already running." };
  const loader = inst.loader || "vanilla";
  if (loader !== "vanilla" && !loaders.supported(loader)) {
    const nice = loader[0].toUpperCase() + loader.slice(1);
    return { started: false, message: `${nice} launch is the next milestone — Vanilla, Fabric, and Quilt launch fully now.` };
  }

  const session = auth.currentSession() || offlineSession(account()?.name || "Player");
  emit("launch:state", { id, status: "installing" });
  emit("launch:log", { line: `Preparing ${inst.name} (${inst.mcVersion})…` });

  try {
    const detail = await install.resolveVersionJSON(DATA_DIR, inst.mcVersion, (m) => emit("launch:log", { line: m }));
    const built = await install.installVersion(DATA_DIR, detail,
      (phase, done, total) => emit("launch:progress", { id, phase, done, total }),
      (m) => emit("launch:log", { line: m }));

    // Modded loaders (Fabric/Quilt): download the loader's libraries and build the
    // overlay that swaps the main class + prepends its classpath onto the vanilla install.
    let overlay = null;
    if (loader !== "vanilla") {
      overlay = await loaders.resolveLoader(DATA_DIR, loader, inst.mcVersion,
        (m) => emit("launch:log", { line: m }),
        (phase, done, total) => emit("launch:progress", { id, phase, done, total }));
      emit("launch:log", { line: `${loader[0].toUpperCase() + loader.slice(1)} ${overlay.loaderVersion} ready.` });
    }

    const p = install.paths(DATA_DIR);
    const gameDir = p.instanceDir(id); fs.mkdirSync(gameDir, { recursive: true });

    emit("launch:state", { id, status: "running" });
    const extraJvm = inst.javaArgs ? String(inst.javaArgs).split(/\s+/).filter(Boolean) : [];
    const child = doLaunch(detail, built, session,
      { gameDir, assetsRoot: p.assets, librariesDir: p.libraries, ramMB: inst.ramMB || undefined, extraJvm, overlay },
      (line) => emit("launch:log", { line }),
      (code) => { delete running[id]; emit("launch:state", { id, status: "idle", code }); });
    running[id] = child;

    const list = readInstances(); const idx = list.findIndex((x) => x.id === id);
    if (idx >= 0) { list[idx].lastPlayed = Date.now(); writeInstances(list); }

    return { started: true, offline: session.offline, message: session.offline ? `Launching ${inst.name} in offline mode…` : `Launching ${inst.name} as ${session.name}…` };
  } catch (e) {
    delete running[id];
    emit("launch:state", { id, status: "idle" });
    emit("launch:log", { line: "Launch failed: " + e.message });
    throw e;
  }
}
function stop(id) { if (running[id]) { running[id].kill(); return true; } return false; }
function isRunning(id) { return !!running[id]; }

module.exports = {
  init, setEmitter, dataDir, info,
  listInstances, createInstance, deleteInstance, updateInstance,
  listVersions, modrinthSearch,
  installContent, listContent, removeContent,
  worldList, worldBackups, worldBackup, worldRestore, worldRename, worldRemove,
  account, signOut, signInStart, signInComplete,
  launch, stop, isRunning,
};
