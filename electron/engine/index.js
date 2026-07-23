// The Lodestone "engine" — a cross-platform Node stand-in for the Swift sidecar.
// Real install + launch + Microsoft auth; persists to the per-user app-data dir.
const fs = require("fs");
const path = require("path");
const os = require("os");
const platform = require("./platform");
const install = require("./install");
const loaders = require("./loaders");
const content = require("./content");
const importer = require("./import");
const share = require("./share");
const curseforge = require("./curseforge");
const worlds = require("./worlds");
const auth = require("./auth");
const cloud = require("./cloud");
const sync = require("./sync"); // [Cloud Sync — Vertical A]
const social = require("./social"); // Vertical B — Friends + Presence
const chat = require("./chat");   // Vertical C — Chat + Squads
const settings = require("./settings");
const serverEngine = require("./server");
const maintenance = require("./maintenance");
const { launch: doLaunch, offlineSession } = require("./launch");

let DATA_DIR = null;
let emit = () => {};
const running = {}; // instanceId -> child process

function init(userDataPath) {
  DATA_DIR = userDataPath || path.join(os.homedir(), ".lodestone");
  fs.mkdirSync(path.join(DATA_DIR, "instances"), { recursive: true });
  auth.init(DATA_DIR);
  cloud.init(DATA_DIR);
  social.init(); // Vertical B: presence/friends realtime follow the cloud session
  settings.init(DATA_DIR);
  // [Cloud Sync — Vertical A] inject the instance store + reconcile path, then
  // open the realtime channel if a session was restored from disk.
  sync.init({
    getInstance: (id) => readInstances().find((i) => i.id === id),
    listInstances: () => readInstances(),
    syncFromCode: (a) => syncInstanceFromCode(a),
    createFromCode: (code) => createInstanceFromCode(code),
  });
  // Open sync + chat realtime if a session was restored from disk at boot.
  startVerticalRealtime();
}

// ---- App settings (memory / Java override / launcher behavior) ----
function getSettings() { return settings.getSettings(); }
function setSettings(patch) { return settings.setSettings(patch); }
function setEmitter(fn) { emit = fn || (() => {}); cloud.setEmitter(emit); sync.setEmitter(emit); social.setEmitter(emit); chat.setEmitter(emit); }

// ---- Cloud account (Lodestone social/sync identity — distinct from Minecraft) ----
function cloudStatus() { return cloud.status(); }
function cloudSignUp(a) { return cloud.signUp(a); }
function cloudSignIn(a) { return cloud.signIn(a); }
function cloudSignOut() { return cloud.signOut(); }
function cloudProfile() { return cloud.getProfile(); }
function cloudUpdateProfile(a) { return cloud.updateProfile(a); }
function cloudLinkMinecraft() { return cloud.linkMinecraft(auth.account()); }
function cloudSearchProfiles(a) { return cloud.searchProfiles(a && a.query); }

// ---- Friends + Presence (Vertical B — social.js) ----
function friendsList() { return social.listFriends(); }
function friendsSearch(a) { return social.searchPeople(a && a.query); }
function friendsRequest(a) { return social.sendRequest(a); }
function friendsRespond(a) { return social.respond(a); }
function friendsRemove(a) { return social.remove(a); }
function friendsBlock(a) { return social.block(a); }
function friendsSetActivity(a) { return social.setActivity(a && a.text); }

function dataDir() { return DATA_DIR; }

// ---- Cloud Sync (Vertical A) — instance manifests ⇄ synced_instances ----
// Re/open the realtime channel around the auth boundary so live reconcile follows
// the session. Guarded so a signed-out / unconfigured launcher is unaffected.
async function cloudSignInSync(a) { const r = await cloudSignIn(a); startVerticalRealtime(); return r; }
async function cloudSignUpSync(a) { const r = await cloudSignUp(a); if (r && r.signedIn) startVerticalRealtime(); return r; }
async function cloudSignOutSync() { stopVerticalRealtime(); return cloudSignOut(); }
function cloudSyncPush(a) { return sync.pushInstance(a && a.instanceId); }
function cloudSyncList() { return sync.listCloud(); }
function cloudSyncPull(a) { return sync.pullInstance(a); }
function cloudSyncRemove(a) { return sync.removeCloud(a); }
function cloudSyncStatus(a) { return sync.syncStatus(a && a.instanceId); }

// ---- Chat + Squads (Vertical C — squad channels + direct messages) ----
function chatCreateSquad(a) { return chat.createSquad(a); }
function chatJoinSquad(a) { return chat.joinSquad(a); }
function chatLeaveSquad(a) { return chat.leaveSquad(a); }
function chatListSquads() { return chat.listSquads(); }
function chatSquadInvite(a) { return chat.squadInvite(a); }
function chatStartDm(a) { return chat.startDm(a); }
function chatListDMs() { return chat.listDMs(); }
function chatHistory(a) { return chat.history(a); }
function chatSend(a) { return chat.send(a); }

// One place to open/close every vertical's realtime around the auth boundary.
// social manages its own via an internal auth listener; sync + chat are driven
// here. All are guarded, so a signed-out / unconfigured launcher is unaffected.
function startVerticalRealtime() { sync.start().catch(() => {}); if (chat.start) chat.start().catch(() => {}); }
function stopVerticalRealtime() { sync.stop(); if (chat.stop) chat.stop(); }

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
  const prefs = settings.getSettings();
  const inst = {
    id, name: (name && name.trim()) || (ldr === "vanilla" ? "Vanilla" : ldr[0].toUpperCase() + ldr.slice(1)),
    mcVersion, loader: ldr, accent: ACCENTS[ldr] || ACCENTS.vanilla,
    ramMB: prefs.defaultRamMB != null
      ? prefs.defaultRamMB
      : (ldr === "vanilla" ? null : Math.min(12288, Math.max(4096, Math.round(os.totalmem() / 1048576) - 2048))),
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

// ---- CurseForge search ----
// Uses the user's own API key (Settings → CurseForge). Returns hits in the same shape
// as modrinthSearch, tagged source:"curseforge", so the Discover UI renders them the same.
async function curseforgeSearch({ query, type, loader, mc }) {
  const key = settings.getSettings().curseforgeKey;
  if (!key) throw new Error("Add your CurseForge API key in Settings to browse CurseForge.");
  return curseforge.search({ query, type, loader, mc, key });
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
// Install a single CurseForge mod into an instance (the CurseForge counterpart of
// installContent). Records upgrade-in-place by projectId, exactly like the Modrinth path.
async function installCurseforgeContent({ instanceId, modId }) {
  const key = settings.getSettings().curseforgeKey;
  if (!key) throw new Error("Add your CurseForge API key in Settings to install from CurseForge.");
  const list = readInstances();
  const inst = list.find((i) => i.id === instanceId);
  if (!inst) throw new Error("Instance not found.");
  const record = await curseforge.installMod({
    dataDir: DATA_DIR, instance: inst, modId, key,
    onLog: (m) => emit("content:log", { instanceId, line: m }),
  });
  inst.content = inst.content || [];
  const existing = inst.content.findIndex((c) => c.projectId === record.projectId);
  if (existing >= 0) inst.content[existing] = record; else inst.content.push(record);
  inst.mods = inst.content.filter((c) => c.kind === "mod").length;
  writeInstances(list);
  return { installed: [record], content: inst.content };
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

// ---- Modpack import (.mrpack or CurseForge .zip) ----
// Peek the archive to route: a Modrinth pack has modrinth.index.json, a CurseForge pack
// has manifest.json. Both spin up a new instance, download files + overrides, and persist
// the populated instance, reusing createInstance for the instance shape.
const AdmZip = require("adm-zip");
function persistInstance(inst) {
  const list = readInstances();
  const idx = list.findIndex((i) => i.id === inst.id);
  if (idx >= 0) { list[idx] = inst; writeInstances(list); }
}
async function importModpack(filePath) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error("Modpack file not found.");
  let format = null;
  try {
    const zip = new AdmZip(filePath);
    if (zip.getEntry("modrinth.index.json")) format = "modrinth";
    else if (zip.getEntry("manifest.json")) format = "curseforge";
  } catch { throw new Error("That file isn't a readable modpack archive."); }

  if (format === "curseforge") {
    const key = settings.getSettings().curseforgeKey;
    if (!key) throw new Error("Importing a CurseForge modpack needs a CurseForge API key. Add one in Settings.");
    return curseforge.importZip({
      dataDir: DATA_DIR, filePath, key, createInstance, persist: persistInstance,
      onLog: (line) => emit("content:log", { line }),
    });
  }
  if (format === "modrinth") {
    return importer.importModpack({
      dataDir: DATA_DIR, filePath, createInstance, persist: persistInstance,
      onLog: (line) => emit("content:log", { line }),
    });
  }
  throw new Error("Unrecognized modpack: expected a Modrinth .mrpack or a CurseForge .zip.");
}

// ---- Share & sync (share code + .mrpack export, one-click sync) ----
// A share code / .mrpack moves a pack (its Modrinth mod list) between machines offline.
// "Sync now" reconciles an instance's mods to a shared definition. Live cross-machine
// auto-sync waits on the accounts backend; these are the manual, offline-capable pieces.
function exportInstanceCode(id) {
  const inst = readInstances().find((i) => i.id === id);
  if (!inst) throw new Error("Instance not found.");
  return share.encodeCode(share.packDef(inst));
}
async function exportInstanceMrpack(id, outPath) {
  const inst = readInstances().find((i) => i.id === id);
  if (!inst) throw new Error("Instance not found.");
  return share.exportMrpack(DATA_DIR, inst, outPath);
}
async function syncInstanceFromCode({ id, code }) {
  const list = readInstances();
  const inst = list.find((i) => i.id === id);
  if (!inst) throw new Error("Instance not found.");
  const def = share.decodeCode(code);
  const summary = await share.syncInstance({
    dataDir: DATA_DIR, instance: inst, def,
    onLog: (line) => emit("content:log", { instanceId: id, line }),
  });
  writeInstances(list);
  return {
    instance: inst,
    added: summary.added.length, removed: summary.removed.length, unchanged: summary.unchanged.length,
  };
}
async function createInstanceFromCode(code) {
  const def = share.decodeCode(code);
  const { instance, summary } = await share.createFromDef({
    dataDir: DATA_DIR, def, createInstance, persist: persistInstance,
    onLog: (line) => emit("content:log", { line }),
  });
  return {
    instance,
    added: summary.added.length, removed: summary.removed.length, unchanged: summary.unchanged.length,
  };
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
    return { started: false, message: `${nice} isn't supported. Vanilla, Fabric, Quilt, NeoForge, and Forge all launch.` };
  }

  const session = auth.currentSession() || offlineSession(account()?.name || "Player");
  emit("launch:state", { id, status: "installing" });
  emit("launch:log", { line: `Preparing ${inst.name} (${inst.mcVersion})…` });

  try {
    const detail = await install.resolveVersionJSON(DATA_DIR, inst.mcVersion, (m) => emit("launch:log", { line: m }));
    const built = await install.installVersion(DATA_DIR, detail,
      (phase, done, total) => emit("launch:progress", { id, phase, done, total }),
      (m) => emit("launch:log", { line: m }));

    // Modded loaders (Fabric/Quilt/NeoForge/Forge): resolve the loader (Fabric/Quilt pull a
    // hosted profile; NeoForge/Forge run their official installer once) and build the overlay
    // that swaps the main class + prepends its classpath onto the vanilla install.
    let overlay = null;
    if (loader !== "vanilla") {
      overlay = await loaders.resolveLoader(DATA_DIR, loader, inst.mcVersion,
        (m) => emit("launch:log", { line: m }),
        (phase, done, total) => emit("launch:progress", { id, phase, done, total }));
      emit("launch:log", { line: `${loader[0].toUpperCase() + loader.slice(1)} ${overlay.loaderVersion} ready.` });
    }

    // A user-supplied Java override wins when it points at a real binary; otherwise
    // stick with the exact Mojang runtime install.js just downloaded.
    const prefs = settings.getSettings();
    if (prefs.javaPath && fs.existsSync(prefs.javaPath)) {
      built.javaBinary = prefs.javaPath;
      emit("launch:log", { line: `Using your Java: ${prefs.javaPath}` });
    }

    const p = install.paths(DATA_DIR);
    const gameDir = p.instanceDir(id); fs.mkdirSync(gameDir, { recursive: true });

    emit("launch:state", { id, status: "running" });
    const extraJvm = inst.javaArgs ? String(inst.javaArgs).split(/\s+/).filter(Boolean) : [];
    const child = doLaunch(detail, built, session,
      { gameDir, assetsRoot: p.assets, librariesDir: p.libraries, ramMB: inst.ramMB || undefined, extraJvm, overlay },
      (line) => emit("launch:log", { line }),
      (code) => { delete running[id]; emit("launch:state", { id, status: "idle", code }); social.setActivity(null); });
    running[id] = child;
    social.setActivity(`Playing ${inst.name}`); // Vertical B: broadcast presence activity

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

// ---- Power tools (repair + bulk content update) ----
// Repair drops the shared cached game files for the instance's MC version; the next
// launch re-installs them. Update walks the instance's Modrinth content and bumps
// anything with a newer build. Both persist through the standard instance store.
function repairInstance(id) {
  const inst = readInstances().find((i) => i.id === id);
  if (!inst) throw new Error("Instance not found.");
  return maintenance.repairInstance({ dataDir: DATA_DIR, instance: inst });
}
async function updateAllContent(id) {
  const list = readInstances();
  const inst = list.find((i) => i.id === id);
  if (!inst) throw new Error("Instance not found.");
  const result = await maintenance.updateAllContent({
    dataDir: DATA_DIR, instance: inst, emit: (channel, payload) => emit(channel, payload),
  });
  inst.mods = (inst.content || []).filter((c) => c.kind === "mod").length;
  writeInstances(list);
  return result;
}

// ---- Dedicated servers (create / run / console / properties) ----
// The server engine streams its console + lifecycle through this module's `emit`,
// on the "server:log" and "server:state" channels the renderer subscribes to.
function listServers() { return serverEngine.list(DATA_DIR); }
async function createServer(opts) {
  return serverEngine.create(DATA_DIR, opts, { onLog: (line) => emit("server:log", { line }) });
}
async function startServer(id) {
  const prefs = settings.getSettings();
  const javaPath = prefs.javaPath && fs.existsSync(prefs.javaPath) ? prefs.javaPath : null;
  return serverEngine.start(DATA_DIR, id, {
    onLog: (line) => emit("server:log", { id, line }),
    onState: (s) => emit("server:state", s),
    javaPath,
  });
}
function stopServer(id) { return serverEngine.stop(id); }
function serverCommand({ id, command }) { return serverEngine.command(id, command); }
function serverProperties(id) { return serverEngine.properties(DATA_DIR, id); }
function setServerProperties({ id, patch }) { return serverEngine.setProperties(DATA_DIR, id, patch); }
function serverHostingInfo(id) { return serverEngine.hostingInfo(DATA_DIR, id); }
function setServerOnlineMode({ id, on }) { return serverEngine.setOnlineMode(DATA_DIR, id, on); }
function removeServer(id) { return serverEngine.remove(DATA_DIR, id); }

module.exports = {
  init, setEmitter, dataDir, info,
  getSettings, setSettings,
  listInstances, createInstance, deleteInstance, updateInstance,
  listVersions, modrinthSearch, curseforgeSearch,
  installContent, installCurseforgeContent, listContent, removeContent,
  importModpack,
  exportInstanceCode, exportInstanceMrpack, syncInstanceFromCode, createInstanceFromCode,
  worldList, worldBackups, worldBackup, worldRestore, worldRename, worldRemove,
  account, signOut, signInStart, signInComplete,
  cloudStatus,
  cloudSignUp: cloudSignUpSync, cloudSignIn: cloudSignInSync, cloudSignOut: cloudSignOutSync, // [Cloud Sync] session-aware
  cloudProfile, cloudUpdateProfile, cloudLinkMinecraft, cloudSearchProfiles,
  // [Cloud Sync — Vertical A]
  cloudSyncPush, cloudSyncList, cloudSyncPull, cloudSyncRemove, cloudSyncStatus,
  // [Friends + Presence — Vertical B]
  friendsList, friendsSearch, friendsRequest, friendsRespond, friendsRemove, friendsBlock, friendsSetActivity,
  // [Chat + Squads — Vertical C]
  chatCreateSquad, chatJoinSquad, chatLeaveSquad, chatListSquads, chatSquadInvite,
  chatStartDm, chatListDMs, chatHistory, chatSend,
  launch, stop, isRunning,
  repairInstance, updateAllContent,
  listServers, createServer, startServer, stopServer, serverCommand,
  serverProperties, setServerProperties, serverHostingInfo, setServerOnlineMode, removeServer,
};

// ============================================================================
// [Content managers vertical — packs.js + keybinds.js]
// Resource pack / shader / datapack managers (per instance, datapacks per
// world) + the keybinds manager. Appended as a self-contained region and
// exported via Object.assign so the shared module surface above is untouched.
// ============================================================================
const packs = require("./packs");
const keybinds = require("./keybinds");

function requirePackInstance(id) {
  const inst = readInstances().find((i) => i.id === id);
  if (!inst) throw new Error("Instance not found.");
  return inst;
}

function packsResourcePacks({ instanceId }) {
  requirePackInstance(instanceId);
  return packs.listResourcePacks(DATA_DIR, instanceId);
}
function packsResourceSet({ instanceId, fileName, enabled }) {
  requirePackInstance(instanceId);
  return packs.setResourcePackEnabled(DATA_DIR, instanceId, fileName, !!enabled);
}
function packsResourceReorder({ instanceId, order }) {
  requirePackInstance(instanceId);
  return packs.reorderResourcePacks(DATA_DIR, instanceId, order);
}
function packsShaders({ instanceId }) {
  requirePackInstance(instanceId);
  return packs.listShaderPacks(DATA_DIR, instanceId);
}
function packsShaderSelect({ instanceId, fileName }) {
  requirePackInstance(instanceId);
  return packs.selectShaderPack(DATA_DIR, instanceId, fileName == null ? null : fileName);
}
function packsDatapacks({ instanceId, world }) {
  requirePackInstance(instanceId);
  return packs.listDatapacks(DATA_DIR, instanceId, world);
}
function packsDelete({ instanceId, kind, fileName, world }) {
  requirePackInstance(instanceId);
  return packs.deletePack(DATA_DIR, instanceId, kind, fileName, world);
}
function packsImport({ instanceId, kind, world, filePath }) {
  requirePackInstance(instanceId);
  return packs.importPack(DATA_DIR, instanceId, kind, world, filePath);
}
function packsFolderPath({ instanceId, kind, world }) {
  requirePackInstance(instanceId);
  return packs.packsFolder(DATA_DIR, instanceId, kind, world);
}
function keybindsList({ instanceId }) {
  requirePackInstance(instanceId);
  return keybinds.list(DATA_DIR, instanceId);
}
function keybindsSet({ instanceId, action, value }) {
  requirePackInstance(instanceId);
  return keybinds.set(DATA_DIR, instanceId, action, value);
}
function keybindsReset({ instanceId, action }) {
  requirePackInstance(instanceId);
  return keybinds.reset(DATA_DIR, instanceId, action);
}
function keybindsResetAll({ instanceId }) {
  requirePackInstance(instanceId);
  return keybinds.resetAll(DATA_DIR, instanceId);
}

Object.assign(module.exports, {
  packsResourcePacks, packsResourceSet, packsResourceReorder,
  packsShaders, packsShaderSelect, packsDatapacks,
  packsDelete, packsImport, packsFolderPath,
  keybindsList, keybindsSet, keybindsReset, keybindsResetAll,
});
