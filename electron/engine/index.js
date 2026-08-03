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
const mixins = require("./mixins");
const seedfinder = require("./seedfinder"); // native cubiomes seed search // static mixin conflict detection
const worldcreate = require("./worldcreate");
const worldinfo = require("./worldinfo");
const region = require("./region"); // .mca reader for the world map + statistics
const files = require("./files"); // Storage screen, file browser, config manager // World detail: facts read out of level.dat // world creation + import (26.1 split format aware)
const auth = require("./auth");
const cloud = require("./cloud");
const sync = require("./sync"); // [Cloud Sync — Vertical A]
const packsync = require("./packsync"); // Shared packs — permanent code + live propagation
const social = require("./social"); // Vertical B — Friends + Presence
const chat = require("./chat");   // Vertical C — Chat + Squads
const doctor = require("./doctor"); // [Crash Doctor] scan + fixes + mod bisect
const settings = require("./settings");
const globalsetup = require("./globalsetup"); // global Game settings + Keybinds + Skins
const serverEngine = require("./server");
const maintenance = require("./maintenance");
const { launch: doLaunch, offlineSession } = require("./launch");

let DATA_DIR = null;
let emit = () => {};
const running = {}; // instanceId -> child process
let sizeCache = null;  // { at, value } for instanceSizes()

const groupsFile = () => path.join(DATA_DIR, "groups.json");
function readGroups() {
  let raw = [];
  try { raw = JSON.parse(fs.readFileSync(groupsFile(), "utf8")); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  // Prune members whose instance is gone, so a deleted pack can't leave a
  // ghost in a group.
  const live = new Set(readInstances().map((i) => i.id));
  return raw.map((g) => ({
    id: g.id, name: g.name, collapsed: !!g.collapsed,
    instanceIds: (g.instanceIds || []).filter((id) => live.has(id)),
  }));
}
function writeGroups(list) { try { fs.writeFileSync(groupsFile(), JSON.stringify(list, null, 2)); } catch { /* best effort */ } }

function init(userDataPath) {
  DATA_DIR = userDataPath || path.join(os.homedir(), ".lodestone");
  fs.mkdirSync(path.join(DATA_DIR, "instances"), { recursive: true });
  auth.init(DATA_DIR);
  cloud.init(DATA_DIR);
  social.init(); // Vertical B: presence/friends realtime follow the cloud session
  settings.init(DATA_DIR);
  globalsetup.init(DATA_DIR);
  // [Cloud Sync — Vertical A] inject the instance store + reconcile path, then
  // open the realtime channel if a session was restored from disk.
  sync.init({
    getInstance: (id) => readInstances().find((i) => i.id === id),
    listInstances: () => readInstances(),
    syncFromCode: (a) => syncInstanceFromCode(a),
    createFromCode: (code) => createInstanceFromCode(code),
  });
  // Shared packs use the same store contract + reconcile path.
  packsync.init({
    dataDir: DATA_DIR,
    store: {
      getInstance: (id) => readInstances().find((i) => i.id === id),
      listInstances: () => readInstances(),
      syncFromCode: (a) => syncInstanceFromCode(a),
      createFromCode: (code) => createInstanceFromCode(code),
    },
  });
  // Open sync + chat realtime if a session was restored from disk at boot.
  startVerticalRealtime();
}

// ---- App settings (memory / Java override / launcher behavior) ----
function getSettings() { return settings.getSettings(); }
function setSettings(patch) { return settings.setSettings(patch); }
function setEmitter(fn) { emit = fn || (() => {}); cloud.setEmitter(emit); sync.setEmitter(emit); social.setEmitter(emit); chat.setEmitter(emit); packsync.setEmitter(emit); }
// [wave0] Trash-tier deletes: Electron main injects shell.trashItem so world /
// resource-pack / shader / datapack deletes are recoverable (Mac parity).
// Headless runs never call this and those deletes stay permanent (flagged).
function setTrash(fn) { worlds.setTrash(fn); packs.setTrash(fn); }

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
function startVerticalRealtime() {
  sync.start().catch(() => {});
  if (chat.start) chat.start().catch(() => {});
  // Shared packs: open the live channel, then reconcile anything that
  // changed while this machine was closed (realtime only covers uptime).
  packsync.start().then(() => packsync.catchUp()).catch(() => {});
}
function stopVerticalRealtime() { sync.stop(); if (chat.stop) chat.stop(); packsync.stop(); }

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
function updateInstance({ id, name, ramMB, javaArgs, mcVersion, pinned }) {
  const list = readInstances();
  const inst = list.find((i) => i.id === id);
  if (!inst) throw new Error("Instance not found.");
  if (name !== undefined) { const n = String(name).trim(); if (n) inst.name = n; }
  if (ramMB !== undefined) { const n = Number(ramMB); inst.ramMB = Number.isFinite(n) && n > 0 ? Math.round(n) : null; }
  if (javaArgs !== undefined) inst.javaArgs = String(javaArgs).trim();
  if (mcVersion !== undefined) { const v = String(mcVersion).trim(); if (v) inst.mcVersion = v; }
  // [Voxel parity] PINNED sidebar block, same as the Mac app's.
  if (pinned !== undefined) inst.pinned = !!pinned;
  writeInstances(list);
  return inst;
}

// ---- Mojang versions ----
// [wave0] Default = releases only (unchanged). Opt in to other channels with
// listVersions({ channels: ["snapshot","old_beta","old_alpha"] }); each requested
// channel comes back as its own manifest-ordered id array (newest first) so the
// create-instance UI can offer "Show snapshots" / "Show old versions" without a
// second fetch. The raw manifest is cached once and every view derives from it.
const MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
let manifestCache = null;
async function fetchManifest() {
  if (manifestCache) return manifestCache;
  const res = await fetch(MANIFEST);
  if (!res.ok) throw new Error(`Mojang manifest ${res.status}`);
  manifestCache = await res.json();
  return manifestCache;
}
const CHANNELS = ["snapshot", "old_beta", "old_alpha"];
async function listVersions(opts) {
  const json = await fetchManifest();
  const idsOfType = (t) => json.versions.filter((v) => v.type === t).map((v) => v.id);
  const out = { releases: idsOfType("release"), latest: json.latest.release, latestSnapshot: json.latest.snapshot };
  const requested = (opts && Array.isArray(opts.channels)) ? opts.channels : [];
  for (const ch of requested) {
    if (CHANNELS.includes(ch)) out[ch === "snapshot" ? "snapshots" : ch] = idsOfType(ch);
  }
  return out;
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
  // If this instance is a shared pack, the change goes out to every member
  // automatically. No new code, no re-share: that is the whole point.
  packsync.publish(instanceId).catch(() => {});
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
  packsync.publish(instanceId).catch(() => {});
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

  // currentSession() refreshes an expired Minecraft token from the stored MSA
  // refresh token (network only when stale). Null = no online session possible.
  const session = (await auth.currentSession()) || offlineSession(account()?.name || "Player");
  if (session.offline && auth.account()) {
    emit("launch:log", { line: "Microsoft sign-in expired or unreachable — launching offline. Sign in again for online play." });
  }
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

    // Stamp the global Game settings + Keybinds profile into this instance's
    // options.txt before the JVM reads it. Never blocks a launch if it fails.
    try { globalsetup.applyToInstance(id); } catch { /* cosmetic */ }

    emit("launch:state", { id, status: "running" });
    const extraJvm = inst.javaArgs ? String(inst.javaArgs).split(/\s+/).filter(Boolean) : [];
    const startedAt = Date.now(); // [Voxel parity] real playtime, banked on exit
    const child = doLaunch(detail, built, session,
      { gameDir, assetsRoot: p.assets, librariesDir: p.libraries, ramMB: inst.ramMB || undefined, extraJvm, overlay },
      (line) => emit("launch:log", { line }),
      (code) => {
        delete running[id];
        addPlaytime(id, Date.now() - startedAt);
        emit("launch:state", { id, status: "idle", code });
        social.setActivity(null);
      });
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

// [Voxel parity] Bank a play session onto the instance's lifetime total.
// The Mac hero and every instance card show "8h 52m played" and a dashed
// playtime bar, which needs a real accumulated figure rather than a guess.
// Sessions under 20s are dropped (a failed launch that exits immediately
// shouldn't register) and anything over 24h is clamped, since a machine that
// slept mid-session reports a wall-clock delta that never actually happened.
function addPlaytime(id, ms) {
  const delta = Number(ms);
  if (!Number.isFinite(delta) || delta < 20_000) return;
  const capped = Math.min(delta, 24 * 60 * 60 * 1000);
  try {
    const list = readInstances();
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) return;
    list[idx].playtimeMs = (Number(list[idx].playtimeMs) || 0) + capped;
    writeInstances(list);
  } catch { /* playtime is cosmetic; never let it break the exit path */ }
}

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

// ---- [Crash Doctor] scan / apply-fix / mod bisect (doctor.js) ----
// Scan reads the newest crash report + latest.log tail and returns ranked diagnoses
// whose fixes map onto real engine actions; doctorFix executes one (RAM edit, Repair,
// disable/remove/update a mod, install a missing dependency) and persists through the
// standard instance store. The bisect is a disk-persisted binary search over the
// enabled mods (rename .jar ⇄ .jar.disabled), driven by the user's crash reports.
function doctorScan(instanceId) {
  const inst = readInstances().find((i) => i.id === instanceId);
  if (!inst) throw new Error("Instance not found.");
  return doctor.scan({ dataDir: DATA_DIR, instance: inst, prefs: settings.getSettings() });
}
async function doctorFix({ instanceId, fix }) {
  const list = readInstances();
  const inst = list.find((i) => i.id === instanceId);
  if (!inst) throw new Error("Instance not found.");
  if (running[instanceId]) throw new Error("Stop the instance before applying a fix.");
  const result = await doctor.applyFix({
    dataDir: DATA_DIR, instance: inst, fix,
    onLog: (m) => emit("content:log", { instanceId, line: m }),
  });
  inst.mods = (inst.content || []).filter((c) => c.kind === "mod").length;
  writeInstances(list);
  return result;
}
function doctorBisectStatus(instanceId) {
  const inst = readInstances().find((i) => i.id === instanceId);
  if (!inst) throw new Error("Instance not found.");
  return doctor.bisectStatus({ dataDir: DATA_DIR, instance: inst });
}
function doctorBisectStart(instanceId) {
  const inst = readInstances().find((i) => i.id === instanceId);
  if (!inst) throw new Error("Instance not found.");
  if (running[instanceId]) throw new Error("Stop the instance before starting a bisect.");
  return doctor.bisectStart({ dataDir: DATA_DIR, instance: inst });
}
function doctorBisectReport({ instanceId, crashed }) {
  const inst = readInstances().find((i) => i.id === instanceId);
  if (!inst) throw new Error("Instance not found.");
  if (running[instanceId]) throw new Error("Stop the instance before reporting the round.");
  return doctor.bisectReport({ dataDir: DATA_DIR, instance: inst, crashed: !!crashed });
}
function doctorBisectAbort({ instanceId, restore }) {
  const inst = readInstances().find((i) => i.id === instanceId);
  if (!inst) throw new Error("Instance not found.");
  return doctor.bisectAbort({ dataDir: DATA_DIR, instance: inst, restore });
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
  init, setEmitter, setTrash, dataDir, info,   // [wave0] setTrash
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
  // ---- Mods with their on-disk enabled state ----
  // The instance's content records say what SHOULD be there; the mods folder
  // says what actually is, and whether it's parked as .jar.disabled. Loose jars
  // the user dropped in by hand are included too, or they'd be invisible here
  // while still loading in game.
  listMods: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    const dir = path.join(install.paths(DATA_DIR).instanceDir(inst.id), "mods");
    let files = [];
    try { files = fs.readdirSync(dir); } catch { files = []; }
    const onDisk = new Map();
    for (const f of files) {
      if (/\.jar$/i.test(f)) onDisk.set(f, true);
      else if (/\.jar\.disabled$/i.test(f)) onDisk.set(f.replace(/\.disabled$/i, ""), false);
    }
    const records = (inst.content || []).filter((c) => (c.kind || "mod") === "mod");
    const seen = new Set();
    const rows = records.map((c) => {
      seen.add(c.fileName);
      return {
        projectId: c.projectId, title: c.title || c.fileName, fileName: c.fileName,
        iconURL: c.iconURL || null, versionNumber: c.versionNumber || "", size: c.size || 0,
        requiredBy: c.requiredBy || null,
        enabled: onDisk.has(c.fileName) ? onDisk.get(c.fileName) : true,
        missing: !onDisk.has(c.fileName),
      };
    });
    for (const [file, enabled] of onDisk) {
      if (seen.has(file)) continue;
      rows.push({ projectId: null, title: file.replace(/\.jar$/i, ""), fileName: file,
        iconURL: null, versionNumber: "", size: 0, requiredBy: null, enabled, missing: false, loose: true });
    }
    const enabledCount = rows.filter((r) => r.enabled && !r.missing).length;
    return { mods: rows, total: rows.length, enabled: enabledCount };
  },
  toggleMod: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    doctor.setModEnabled(DATA_DIR, inst.id, a.fileName, !!a.enabled);
    packsync.publish(inst.id).catch(() => {});
    return true;
  },
  // ---- Storage / files / configs ----
  storage: () => files.storage({ dataDir: DATA_DIR, instances: readInstances() }),
  reclaim: (a) => files.reclaim({ dataDir: DATA_DIR, bucket: a && a.bucket }),
  browseFiles: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    return files.listDir({ root: install.paths(DATA_DIR).instanceDir(inst.id), rel: a && a.rel });
  },
  readFile: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    return files.readText({ root: install.paths(DATA_DIR).instanceDir(inst.id), rel: a && a.rel });
  },
  writeFile: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    return files.writeText({ root: install.paths(DATA_DIR).instanceDir(inst.id), rel: a && a.rel, text: a && a.text });
  },
  listConfigs: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    return files.listConfigs({ instanceDir: install.paths(DATA_DIR).instanceDir(inst.id) });
  },

  // ---- World detail ----
  worldInfo: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    return worldinfo.worldInfo({
      instanceDir: install.paths(DATA_DIR).instanceDir(inst.id),
      folder: a && a.world,
    });
  },

  // ---- World map / statistics (reads the region files) ----
  worldScan: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    const dir = path.join(install.paths(DATA_DIR).instanceDir(inst.id), "saves", a.world);
    // 26.1 moved the overworld's regions under dimensions/; try both.
    const candidates = [
      path.join(dir, "region"),
      path.join(dir, "dimensions", "minecraft", "overworld", "region"),
    ];
    for (const c of candidates) {
      const res = region.scanDimension({ regionDir: c, maxRegions: (a && a.maxRegions) || 24 });
      if (res) return res;
    }
    return { chunks: 0, biomes: [], cells: [], regionsScanned: 0, regionsTotal: 0 };
  },

  // ---- Instance groups (the Instances page's named sections) ----
  // Membership lives here rather than on the instance so an instance can be
  // regrouped without rewriting instances.json, and so a group survives an
  // instance being deleted (it is pruned on read instead).
  listGroups: () => readGroups(),
  saveGroup: (a) => {
    const groups = readGroups();
    if (a && a.id) {
      const g = groups.find((x) => x.id === a.id);
      if (!g) throw new Error("Group not found.");
      if (a.name !== undefined) g.name = String(a.name).trim() || g.name;
      if (a.collapsed !== undefined) g.collapsed = !!a.collapsed;
      if (Array.isArray(a.instanceIds)) g.instanceIds = a.instanceIds.slice();
    } else {
      const name = String((a && a.name) || "").trim();
      if (!name) throw new Error("Name the group.");
      groups.push({ id: "g" + Date.now().toString(36), name, collapsed: false, instanceIds: [] });
    }
    writeGroups(groups);
    return readGroups();
  },
  deleteGroup: (a) => {
    // Deleting a group never deletes instances — they fall back to Ungrouped.
    writeGroups(readGroups().filter((g) => g.id !== (a && a.id)));
    return readGroups();
  },
  setInstanceGroup: (a) => {
    const groups = readGroups();
    for (const g of groups) g.instanceIds = g.instanceIds.filter((x) => x !== a.instanceId);
    if (a.groupId) {
      const g = groups.find((x) => x.id === a.groupId);
      if (g) g.instanceIds.push(a.instanceId);
    }
    writeGroups(groups);
    return readGroups();
  },

  // ---- Screenshots tab ----
  listScreenshots: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    const dir = path.join(install.paths(DATA_DIR).instanceDir(inst.id), "screenshots");
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)); } catch { return { shots: [], dir }; }
    const shots = files.map((f) => {
      const full = path.join(dir, f);
      let st = null;
      try { st = fs.statSync(full); } catch { /* vanished */ }
      return { name: f, path: full, size: st ? st.size : 0, modified: st ? st.mtimeMs : 0 };
    }).sort((x, y) => y.modified - x.modified);
    return { shots, dir };
  },

  // ---- Logs tab ----
  readInstanceLog: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    const logDir = path.join(install.paths(DATA_DIR).instanceDir(inst.id), "logs");
    const file = path.join(logDir, "latest.log");
    let text = "";
    try {
      const st = fs.statSync(file);
      const fd = fs.openSync(file, "r");
      // Only the tail: a modded latest.log runs to tens of megabytes and the
      // interesting part is always at the end.
      const want = Math.min(st.size, 256 * 1024);
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, st.size - want);
      fs.closeSync(fd);
      text = buf.toString("utf8");
      if (st.size > want) text = text.slice(text.indexOf("\n") + 1);
    } catch { return { lines: [], exists: false, dir: logDir }; }
    const lines = text.split(/\r?\n/).filter(Boolean).slice(-600);
    return { lines, exists: true, dir: logDir };
  },

  // ---- Sinytra Connector: NeoForge packs can run Fabric mods when it's present.
  loaderBridge: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    if (inst.loader !== "neoforge" && inst.loader !== "forge") return { connector: false };
    const dir = path.join(install.paths(DATA_DIR).instanceDir(inst.id), "mods");
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return { connector: false }; }
    const hit = files.find((f) => /^(connector|sinytra)[-_.]/i.test(f) && /\.jar$/i.test(f));
    return { connector: !!hit, jar: hit || null };
  },

  // ---- Disk usage per instance (the Instances page footer) ----
  // Walking 70+ instance trees is not free, so results are cached for a minute;
  // the footer is a quiet fact, not something worth stalling a render for.
  instanceSizes: () => {
    const now = Date.now();
    if (sizeCache && now - sizeCache.at < 60_000) return sizeCache.value;
    const dirSize = (dir) => {
      let total = 0;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) total += dirSize(full);
        else if (e.isFile()) { try { total += fs.statSync(full).size; } catch { /* vanished mid-walk */ } }
      }
      return total;
    };
    const p = install.paths(DATA_DIR);
    const out = {};
    let total = 0;
    for (const inst of readInstances()) {
      const bytes = dirSize(p.instanceDir(inst.id));
      out[inst.id] = bytes;
      total += bytes;
    }
    const value = { sizes: out, total };
    sizeCache = { at: now, value };
    return value;
  },
  // ---- Seed search (native cubiomes helper; vanilla worldgen only) ----
  seedSearchAvailable: () => seedfinder.available(),
  seedSearch: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    const modsDir = path.join(install.paths(DATA_DIR).instanceDir(inst.id), "mods");
    return seedfinder.search({
      mcVersion: inst.mcVersion,
      biomes: a && a.biomes,
      radius: a && a.radius,
      count: a && a.count,
      startSeed: a && a.startSeed,
      modsDir,
      onEvent: (e) => emit("seed:progress", { instanceId: inst.id, ...e }),
    });
  },
  // ---- Mixin conflicts: find mods patching the same method, without launching ----
  scanMixins: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    const modsDir = path.join(install.paths(DATA_DIR).instanceDir(inst.id), "mods");
    let files = [];
    try { files = fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith(".jar")); } catch { return { conflicts: [], cooperativeOverlaps: 0, scanned: 0, jars: 0 }; }
    let all = [];
    let unreadable = 0;
    for (const f of files) {
      const name = f.replace(/\.jar$/i, "").replace(/[-_](fabric|neoforge|forge|mc)?[-_]?\d[\d.+\w-]*$/i, "");
      try { all = all.concat(mixins.scanJar(path.join(modsDir, f), name)); } catch { unreadable++; }
    }
    return { ...mixins.analyze(all), jars: files.length, unreadable };
  },
  // ---- Worlds: create + import ----
  createWorld: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    const p = install.paths(DATA_DIR);
    return worldcreate.createWorld({
      ...a,
      instanceDir: p.instanceDir(inst.id),
      mcVersion: inst.mcVersion,
      jarPath: p.versionJar(inst.mcVersion),
    });
  },
  importWorld: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    return worldcreate.importWorld({
      instanceDir: install.paths(DATA_DIR).instanceDir(inst.id),
      source: a && a.source,
    });
  },
  // ---- Global SETUP: Game settings / Keybinds / Skins ----
  gameSettingsGet: () => globalsetup.getGameSettings(),
  gameSettingsSet: (a) => globalsetup.setGameSettings(a),
  gameSettingsApply: (a) => globalsetup.setApplyOnLaunch(a && a.on),
  keybindProfileGet: () => globalsetup.getKeybindProfile(),
  keybindProfileSet: (a) => globalsetup.setKeybindProfile(a),
  keybindProfileReset: () => globalsetup.resetKeybindProfile(),
  keybindDisabled: (a) => globalsetup.setKeybindDisabled(a),
  keybindApply: (a) => globalsetup.setKeybindApply(a && a.on),
  keybindPreset: (a) => globalsetup.keybindPreset(a),
  keybindRefresh: () => { globalsetup.refreshDiscovered(DATA_DIR); return globalsetup.getKeybindProfile(); },
  skinProfile: async () => { const ses = await auth.currentSession(); return globalsetup.getProfile(ses && ses.accessToken); },
  skinUpload: async (a) => { const ses = await auth.currentSession(); return globalsetup.uploadSkin({ token: ses && ses.accessToken, dataBase64: a && a.dataBase64, variant: a && a.variant }); },
  skinReset: async () => { const ses = await auth.currentSession(); return globalsetup.resetSkin(ses && ses.accessToken); },
  // ---- Shared packs (permanent code + live propagation) ----
  packShare: (a) => packsync.createShare(a),
  packJoin: (a) => packsync.joinByCode(a && a.code),
  packPublish: (a) => packsync.publish(a && a.instanceId, { silent: false }),
  packList: () => packsync.listShares(),
  packStatus: (a) => packsync.statusFor(a && a.instanceId),
  packSetMode: (a) => packsync.setMode(a),
  packInvite: (a) => packsync.inviteFriend(a),
  packMembers: (a) => packsync.members(a && a.packId),
  packLeave: (a) => packsync.leave(a && a.packId),
  // [Friends + Presence — Vertical B]
  friendsList, friendsSearch, friendsRequest, friendsRespond, friendsRemove, friendsBlock, friendsSetActivity,
  // [Chat + Squads — Vertical C]
  chatCreateSquad, chatJoinSquad, chatLeaveSquad, chatListSquads, chatSquadInvite,
  chatStartDm, chatListDMs, chatHistory, chatSend,
  launch, stop, isRunning,
  repairInstance, updateAllContent,
  // [Crash Doctor]
  doctorScan, doctorFix, doctorBisectStatus, doctorBisectStart, doctorBisectReport, doctorBisectAbort,
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

// ============================================================================
// [Icons + .lodepack — vertical feat/win-icons-lodepack] — additive section.
// Per-instance icons (a real icon.* file in the instance dir, tracked on the
// record) and Lodestone's own .lodepack format (v1 JSON + v2 container import,
// v2 export), plus a unified importer that routes any pack file by its actual
// contents. Exports are attached via Object.assign so the section stays a pure
// append; `importModpack` is re-pointed at the unified router so the classic
// import path accepts .lodepack too and picks up pack icons.
const iconsEngine = require("./icons");
const lodepack = require("./lodepack");

// ---- Instance icons ----
function setInstanceIcon({ id, dataBase64, ext }) {
  const list = readInstances();
  const inst = list.find((i) => i.id === id);
  if (!inst) throw new Error("Instance not found.");
  const buffer = Buffer.from(String(dataBase64 || ""), "base64");
  iconsEngine.setIconBuffer({ dataDir: DATA_DIR, instance: inst, buffer, ext });
  writeInstances(list);
  return inst;
}
function removeInstanceIcon({ id }) {
  const list = readInstances();
  const inst = list.find((i) => i.id === id);
  if (!inst) throw new Error("Instance not found.");
  iconsEngine.removeIcon({ dataDir: DATA_DIR, instance: inst });
  writeInstances(list);
  return inst;
}

// Some .mrpack / CurseForge archives ship a root-level icon.* alongside the index
// (non-standard but common); adopt it as the new instance's icon when present.
function adoptArchiveIcon(filePath, inst) {
  const zip = new AdmZip(filePath);
  for (const ext of iconsEngine.ICON_EXTS) {
    const entry = zip.getEntry(`icon.${ext}`);
    if (entry && !entry.isDirectory) {
      const updated = setInstanceIcon({ id: inst.id, dataBase64: entry.getData().toString("base64"), ext });
      inst.icon = updated.icon; inst.iconPath = updated.iconPath; inst.iconVersion = updated.iconVersion;
      return true;
    }
  }
  return false;
}

// ---- .lodepack import (v1 JSON) ----
// The old plain-JSON SharePack: rebuild via the existing share.js Modrinth install
// path. A failure mid-install discards the half-created instance.
async function importLodepackV1(filePath) {
  const def = lodepack.readV1(filePath);
  let created = null;
  const trackCreate = (opts) => { created = createInstance(opts); return created; };
  try {
    const { instance, summary } = await share.createFromDef({
      dataDir: DATA_DIR, def, createInstance: trackCreate, persist: persistInstance,
      onLog: (line) => emit("content:log", { line }),
    });
    if (def.skippedLocal) {
      emit("content:log", { line: `${def.skippedLocal} non-Modrinth item${def.skippedLocal === 1 ? "" : "s"} skipped — v1 packs don't carry their files.` });
    }
    return { ...instance, importSummary: { format: 1, linked: summary.added.length, bundled: 0, skippedLocal: def.skippedLocal, failedDownloads: [] } };
  } catch (e) {
    if (created) { try { deleteInstance(created.id); } catch {} }
    throw e;
  }
}

// ---- Unified pack import ----
// Routes by real file contents: .lodepack v2 container → lodepack importer,
// .lodepack v1 JSON → SharePack rebuild, anything else → the existing
// .mrpack / CurseForge .zip importer (plus root-icon pickup).
async function importAnyPack(filePath) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error("Pack file not found.");
  const kind = lodepack.detect(filePath);
  if (kind === "lodepack2") {
    return lodepack.importLodepack({
      dataDir: DATA_DIR, filePath, createInstance, persist: persistInstance,
      discard: (id) => { try { deleteInstance(id); } catch {} },
      onLog: (line) => emit("content:log", { line }),
    });
  }
  if (kind === "lodepack1") return importLodepackV1(filePath);
  if (/\.lodepack$/i.test(filePath)) {
    throw new Error("This .lodepack isn't valid — it has no lodepack.json manifest. Re-export it from Lodestone and try again.");
  }
  const inst = await importModpack(filePath);
  try { adoptArchiveIcon(filePath, inst); } catch {}
  return inst;
}

// ---- .lodepack export ----
async function exportInstanceLodepack(id, outPath) {
  const inst = readInstances().find((i) => i.id === id);
  if (!inst) throw new Error("Instance not found.");
  let author = null;
  try { const a = account(); author = (a && a.name) || null; } catch {}
  return lodepack.exportLodepack({
    dataDir: DATA_DIR, instance: inst, outPath, author,
    onLog: (line) => emit("content:log", { instanceId: id, line }),
  });
}

Object.assign(module.exports, {
  setInstanceIcon, removeInstanceIcon,
  importAnyPack, exportInstanceLodepack,
  importModpack: importAnyPack, // classic channel now routes .lodepack + adopts pack icons
});
