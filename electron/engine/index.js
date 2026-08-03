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
const files = require("./files");
const lan = require("./lan"); // passive LAN world discovery // Storage screen, file browser, config manager // World detail: facts read out of level.dat // world creation + import (26.1 split format aware)
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
const pregen = require("./pregen"); // chunk pregeneration via a headless server + Chunky
const maintenance = require("./maintenance");
const { launch: doLaunch, offlineSession } = require("./launch");

let DATA_DIR = null;
let emit = () => {};
const running = {}; // instanceId -> child process
// Read once from package.json so the Updates sheet reports the real installed
// version rather than a hardcoded string that drifts every release.
const APP_VERSION = (() => {
  try { return require("../../package.json").version; } catch { return null; }
})();
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
  plugins.init(DATA_DIR);
  themes.init(DATA_DIR);
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
  restartBackupTimer();
}

// ---- App settings (memory / Java override / launcher behavior) ----
function getSettings() { return settings.getSettings(); }
function setSettings(patch) { return settings.setSettings(patch); }
function setEmitter(fn) { emit = fn || (() => {}); playit.setEmitter(emit); cloud.setEmitter(emit); sync.setEmitter(emit); social.setEmitter(emit); chat.setEmitter(emit); packsync.setEmitter(emit); }
// [wave0] Trash-tier deletes: Electron main injects shell.trashItem so world /
// resource-pack / shader / datapack deletes are recoverable (Mac parity).
// Headless runs never call this and those deletes stay permanent (flagged).
let trashItem = null;
function setTrash(fn) { trashItem = fn; worlds.setTrash(fn); packs.setTrash(fn); }

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
    appVersion: APP_VERSION,
  };
}

// ---- Instance store ----
const instancesFile = () => path.join(DATA_DIR, "instances.json");
function readInstances() { try { return JSON.parse(fs.readFileSync(instancesFile(), "utf8")); } catch { return []; } }
function writeInstances(list) { fs.writeFileSync(instancesFile(), JSON.stringify(list, null, 2)); }
function listInstances() {
  // Explicitly ordered instances come first in their chosen order; the rest
  // fall back to most-recently-played, which is the useful default.
  return readInstances().sort((a, b) => {
    const ai = Number.isFinite(a.sortIndex) ? a.sortIndex : Infinity;
    const bi = Number.isFinite(b.sortIndex) ? b.sortIndex : Infinity;
    if (ai !== bi) return ai - bi;
    return (b.lastPlayed || b.created) - (a.lastPlayed || a.created);
  });
}

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
const MODRINTH_UA = "Lodestone/1.0 (github.com/pikzelperfekt/lodestone-desktop)";
async function modrinthJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": MODRINTH_UA } });
  if (!res.ok) throw new Error(`Modrinth ${res.status}`);
  return res.json();
}

// Categories worth filtering by, kept short deliberately: Modrinth exposes
// dozens and a wall of checkboxes is worse than none.
const MODRINTH_CATEGORIES = [
  "adventure", "cursed", "decoration", "economy", "equipment", "food",
  "game-mechanics", "library", "magic", "management", "minigame", "mobs",
  "optimization", "social", "storage", "technology", "transportation", "utility", "worldgen",
];

async function modrinthSearch({ query, type, loader, mc, categories, sort, offset }) {
  const facets = [[`project_type:${type || "mod"}`]];
  if ((type || "mod") === "mod" && loader && loader !== "vanilla") facets.push([`categories:${loader}`]);
  if ((type || "mod") !== "modpack" && mc) facets.push([`versions:${mc}`]);
  // Each extra category is its own AND group, so several narrow rather than widen.
  for (const c of (categories || [])) if (MODRINTH_CATEGORIES.includes(c)) facets.push([`categories:${c}`]);

  const url = new URL("https://api.modrinth.com/v2/search");
  url.searchParams.set("query", query || "");
  url.searchParams.set("limit", "30");
  url.searchParams.set("offset", String(Math.max(0, Number(offset) || 0)));
  url.searchParams.set("index", ["relevance", "downloads", "follows", "newest", "updated"].includes(sort) ? sort : "relevance");
  url.searchParams.set("facets", JSON.stringify(facets));
  const json = await modrinthJSON(url);
  return {
    total: json.total_hits,
    offset: json.offset,
    categories: MODRINTH_CATEGORIES,
    hits: json.hits.map((h) => ({
      id: h.project_id, title: h.title, author: h.author, description: h.description,
      downloads: h.downloads, follows: h.follows, icon: h.icon_url, type: h.project_type,
      categories: (h.categories || []).filter((c) => MODRINTH_CATEGORIES.includes(c)),
      updated: h.date_modified,
    })),
  };
}

// One project's full detail: long description, gallery, and every version that
// fits this instance, so a specific build can be chosen rather than "latest".
async function modrinthProject({ projectId, loader, mc }) {
  const [proj, versions] = await Promise.all([
    modrinthJSON(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}`),
    modrinthJSON(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version`),
  ]);
  const fits = (v) =>
    (!mc || (v.game_versions || []).includes(mc)) &&
    (!loader || loader === "vanilla" || (v.loaders || []).includes(loader));
  const rows = (versions || []).map((v) => ({
    id: v.id, name: v.name, versionNumber: v.version_number, type: v.version_type,
    published: v.date_published, downloads: v.downloads,
    gameVersions: v.game_versions || [], loaders: v.loaders || [],
    changelog: v.changelog || "", compatible: fits(v),
    size: (v.files && v.files[0] && v.files[0].size) || 0,
  }));
  return {
    id: proj.id, title: proj.title, description: proj.description, body: proj.body || "",
    icon: proj.icon_url, downloads: proj.downloads, follows: proj.followers,
    categories: proj.categories || [], license: (proj.license && proj.license.id) || null,
    source: proj.source_url || null, issues: proj.issues_url || null, wiki: proj.wiki_url || null,
    gallery: (proj.gallery || []).slice(0, 12).map((g) => ({ url: g.url, title: g.title || "" })),
    versions: rows,
    compatibleCount: rows.filter((r) => r.compatible).length,
  };
}

// ---- CurseForge search ----
// Uses the user's own API key (Settings → CurseForge). Returns hits in the same shape
// as modrinthSearch, tagged source:"curseforge", so the Discover UI renders them the same.
async function curseforgeProject({ projectId, loader, mc }) {
  const key = settings.getSettings().curseforgeKey;
  if (!key) throw new Error("Add your CurseForge API key in Settings to browse CurseForge.");
  return curseforge.project(projectId, { loader, mc }, key);
}

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
async function launch(id, opts) {
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
      { gameDir, assetsRoot: p.assets, librariesDir: p.libraries, ramMB: inst.ramMB || undefined, extraJvm, overlay,
        joinServer: opts && opts.joinServer, quickPlayWorld: opts && opts.quickPlayWorld },
      (line) => {
        emit("launch:log", { line });
        // Diagnostic mods print FPS and F3-style heap lines; lift them as they
        // stream so the HUD is live rather than a post-mortem.
        const fps = livestats.fpsFromLine(line);
        const heap = livestats.memoryFractionFromLine(line);
        if (fps !== null || heap !== null) emit("stats:tick", { instanceId: id, fps, heap });
      },
      (code) => {
        delete running[id];
        addPlaytime(id, Date.now() - startedAt, startedAt);
        // A non-zero exit is the one moment the user genuinely wants telling
        // about after the fact — the window is gone by then.
        if (code) notify({ kind: "warn", title: `${inst.name} exited unexpectedly`,
                           body: `Exit code ${code}. Check the Logs tab, or run the Crash doctor.` });
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
function addPlaytime(id, ms, startedAt) {
  const delta = Number(ms);
  if (!Number.isFinite(delta) || delta < 20_000) return;
  const capped = Math.min(delta, 24 * 60 * 60 * 1000);
  try {
    const list = readInstances();
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) return;
    list[idx].playtimeMs = (Number(list[idx].playtimeMs) || 0) + capped;
    writeInstances(list);
    // One row per session. This is what the history, heatmap, Wrapped and
    // achievements are all computed from — a running total alone can't say
    // WHEN you played, so the total is kept and the sessions are kept beside it.
    appendSession({ instanceId: id, startedAt: startedAt || (Date.now() - capped), endedAt: Date.now(), ms: capped });
  } catch { /* playtime is cosmetic; never let it break the exit path */ }
}

const backupSettingsFile = () => path.join(DATA_DIR, "backup-schedule.json");
const BACKUP_DEFAULTS = { enabled: false, everyHours: 12, keep: 5, lastRun: 0 };
function readBackupSettings() {
  try { return { ...BACKUP_DEFAULTS, ...JSON.parse(fs.readFileSync(backupSettingsFile(), "utf8")) }; }
  catch { return { ...BACKUP_DEFAULTS }; }
}
function writeBackupSettings(v) {
  try { fs.writeFileSync(backupSettingsFile(), JSON.stringify(v, null, 2)); } catch { /* best effort */ }
}

let backupTimer = null;
function restartBackupTimer() {
  if (backupTimer) { clearInterval(backupTimer); backupTimer = null; }
  const cfg = readBackupSettings();
  if (!cfg.enabled) return;
  // Check hourly rather than sleeping for the whole interval, so a launcher
  // left open across a missed window still catches up.
  backupTimer = setInterval(() => runScheduledBackups(false), 60 * 60 * 1000);
  if (backupTimer.unref) backupTimer.unref();
}

function runScheduledBackups(force) {
  const cfg = readBackupSettings();
  if (!force && !cfg.enabled) return { skipped: "disabled" };
  if (!force && Date.now() - (cfg.lastRun || 0) < cfg.everyHours * 3600_000) return { skipped: "too soon" };

  const made = [];
  for (const inst of readInstances()) {
    // A running instance is writing to its world; zipping it now would produce
    // an archive that restores broken.
    if (running[inst.id]) continue;
    let list = [];
    try { list = worlds.list(DATA_DIR, inst.id); } catch { continue; }
    for (const w of list) {
      try { made.push(worlds.backup(DATA_DIR, inst.id, w.name)); } catch { /* skip this world */ }
    }
    // Prune per instance so one busy pack can't evict another's history.
    try {
      const keep = cfg.keep;
      const all = worlds.backups(DATA_DIR, inst.id).sort((a, b) => (b.created || 0) - (a.created || 0));
      const byWorld = {};
      for (const b of all) (byWorld[b.world] = byWorld[b.world] || []).push(b);
      for (const rows of Object.values(byWorld)) {
        for (const old of rows.slice(keep)) {
          try { fs.rmSync(old.file, { force: true }); } catch { /* already gone */ }
        }
      }
    } catch { /* pruning is best effort */ }
  }

  cfg.lastRun = Date.now();
  writeBackupSettings(cfg);
  if (made.length) notify({ kind: "info", title: `Backed up ${made.length} world${made.length === 1 ? "" : "s"}`,
                            body: "Scheduled backup finished. Older copies beyond your keep count were removed." });
  return { made: made.length };
}

// Everything pregen.js needs from the rest of the engine, in one place so it
// stays free of this file's wiring.
function pregenDeps() {
  return {
    getInstance: (id) => readInstances().find((i) => i.id === id),
    createServer: (opts, cb) => serverEngine.create(DATA_DIR, opts, cb),
    startServer: (id, cb) => serverEngine.start(DATA_DIR, id, cb),
    stopServer: (id) => serverEngine.stop(id),
    command: (id, cmd) => serverEngine.command(id, cmd),
    serverDir: (id) => path.join(DATA_DIR, "servers", id),
    installServerMod: (o) => installServerMod(o),
  };
}

// Download one Modrinth project's newest matching file straight into a
// server's mods (or plugins, for Paper) folder. Servers are not instances, so
// the instance content path does not apply.
async function installServerMod({ serverId, project, loader, mc }) {
  const UA = "Lodestone/1.0 (github.com/pikzelperfekt/lodestone-desktop)";
  const loaderFacet = loader === "paper" ? "paper" : loader;
  const url = new URL(`https://api.modrinth.com/v2/project/${encodeURIComponent(project)}/version`);
  url.searchParams.set("loaders", JSON.stringify([loaderFacet]));
  if (mc) url.searchParams.set("game_versions", JSON.stringify([mc]));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Modrinth ${res.status}`);
  const versions = await res.json();
  const pick = versions[0];
  const file = pick && (pick.files || []).find((f) => f.primary) || (pick && pick.files && pick.files[0]);
  if (!file) throw new Error(`No ${project} build for ${loaderFacet} ${mc}.`);

  const dir = path.join(DATA_DIR, "servers", serverId, loader === "paper" ? "plugins" : "mods");
  fs.mkdirSync(dir, { recursive: true });
  const bin = await fetch(file.url, { headers: { "User-Agent": UA } });
  if (!bin.ok) throw new Error(`Download failed (${bin.status}).`);
  fs.writeFileSync(path.join(dir, file.filename), Buffer.from(await bin.arrayBuffer()));
  return { file: file.filename };
}

const notificationsFile = () => path.join(DATA_DIR, "notifications.json");
function readNotifications() {
  try { const j = JSON.parse(fs.readFileSync(notificationsFile(), "utf8")); return Array.isArray(j) ? j : []; }
  catch { return []; }
}
function writeNotifications(list) {
  try { fs.writeFileSync(notificationsFile(), JSON.stringify(list.slice(0, 100), null, 2)); } catch { /* best effort */ }
}
// Called from anywhere in the engine that has something worth surfacing.
function notify({ kind, title, body }) {
  const list = readNotifications();
  list.unshift({ id: "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                 kind: kind || "info", title: String(title || ""), body: String(body || ""), at: Date.now() });
  writeNotifications(list);
  emit("notify", list[0]);
}

const sessionsFile = () => path.join(DATA_DIR, "sessions.json");
function readSessions() {
  try { const j = JSON.parse(fs.readFileSync(sessionsFile(), "utf8")); return Array.isArray(j) ? j : []; }
  catch { return []; }
}
function appendSession(row) {
  const all = readSessions();
  all.push(row);
  // Two years is plenty for every view built on this, and keeps the file small.
  const cutoff = Date.now() - 730 * 86400_000;
  const trimmed = all.filter((s) => (s.endedAt || 0) >= cutoff);
  try { fs.writeFileSync(sessionsFile(), JSON.stringify(trimmed)); } catch { /* best effort */ }
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

// ---- Publish an instance as a public modpack ----
// Distinct from packPublish/pack:* above, which is the shared-pack (live sync)
// feature. This one makes a one-way public install page anyone can open with
// no account, on the same worker the Mac app publishes to.
function publishInstance(a) {
  const inst = readInstances().find((i) => i.id === (a && a.instanceId));
  if (!inst) throw new Error("Instance not found.");
  const acct = auth.account();   // { name, uuid } of the signed-in Minecraft account
  return publish.publishInstance({
    dataDir: DATA_DIR,
    instance: inst,
    account: acct,
    summary: a && a.summary,
    backend: (getSettings() || {}).socialBackendURL,
    onPhase: (phase) => emit("publish:phase", { instanceId: inst.id, phase }),
    onLog: (line) => emit("publish:log", { instanceId: inst.id, line }),
  });
}

// ---- exaroton cloud hosting ----
// The token lives in settings; every call reads it fresh so disconnecting takes
// effect immediately rather than at the next restart.
function exaTok() {
  const t = (getSettings() || {}).exarotonToken;
  if (!t) throw new Error("Connect your exaroton account first.");
  return t;
}
async function exarotonConnect(a) {
  const token = String((a && a.token) || "").trim();
  if (!token) throw new Error("Paste your exaroton API token.");
  // Verify before saving, so a bad token never gets stored as if it worked.
  const acct = await exaroton.account(token);
  setSettings({ exarotonToken: token });
  return { account: acct, servers: await exaroton.servers(token) };
}
function exarotonDisconnect() { setSettings({ exarotonToken: "" }); return { connected: false }; }
async function exarotonStatus() {
  const token = (getSettings() || {}).exarotonToken;
  if (!token) return { connected: false };
  try {
    return { connected: true, account: await exaroton.account(token), servers: await exaroton.servers(token) };
  } catch (e) {
    return { connected: true, error: e.message, servers: [] };
  }
}
function exarotonRefresh() { return exarotonStatus(); }
function exarotonStart(a) { return exaroton.start(exaTok(), a.id); }
function exarotonStop(a) { return exaroton.stop(exaTok(), a.id); }
function exarotonRestart(a) { return exaroton.restart(exaTok(), a.id); }
function exarotonCommand(a) { return exaroton.command(exaTok(), a.id, a.command); }
function exarotonLogs(a) { return exaroton.logs(exaTok(), a.id); }
function exarotonPushMods(a) {
  const inst = readInstances().find((i) => i.id === (a && a.instanceId));
  if (!inst) throw new Error("Instance not found.");
  // Client-only content would crash or no-op on a dedicated server.
  const clientOnly = (inst.content || [])
    .filter((c) => c && (c.side === "client" || c.clientOnly === true))
    .map((c) => c.fileName)
    .filter(Boolean);
  return exaroton.pushMods({
    token: exaTok(), serverId: a.serverId, clientOnly,
    modsDir: path.join(install.paths(DATA_DIR).instanceDir(inst.id), "mods"),
    onLog: (line) => emit("exaroton:log", { serverId: a.serverId, line }),
  });
}

// ---- playit.gg tunnel ----
function playitStatus() { return { ...playit.status(), secret: !!(getSettings() || {}).playitSecret }; }
function playitSetSecret(a) { setSettings({ playitSecret: String((a && a.secret) || "").trim() }); return playitStatus(); }
function playitStart() { playit.start((getSettings() || {}).playitSecret); return playitStatus(); }
function playitStop() { playit.stop(); return playitStatus(); }

// ---- Plugins ----
function pluginList() { return plugins.list(); }
function pluginSetEnabled(id, enabled) { return plugins.setEnabled(id, enabled); }
function pluginRemove(id) { return plugins.remove(id, trashItem); }
function pluginInstall(repo) { return plugins.install(repo); }
function pluginCommunity() { return plugins.community(); }
function pluginTabs() { return plugins.contributedTabs(); }
function pluginThemes() { return plugins.contributedThemes(); }
function pluginMainScript(id) { return plugins.mainScript(id); }
function pluginGetData(id, key) { return plugins.getData(id, key); }
function pluginSetData(id, key, value) { return plugins.setData(id, key, value); }
function pluginsDir() { return plugins.pluginsDir(); }

// Read a file from INSIDE a plugin's own folder. A plugin names the file, so the
// resolved path is checked to still be under its directory -- "../../id_rsa"
// must not resolve to something we then hand back to it.
function pluginReadFile(id, rel) {
  const plugin = plugins.list().find((p) => p.id === id);
  if (!plugin) return null;
  const full = path.resolve(plugin.folder, String(rel || ""));
  const root = path.resolve(plugin.folder) + path.sep;
  if (!full.startsWith(root)) return null;
  try { return fs.readFileSync(full, "utf8"); } catch { return null; }
}

// ---- Themes ----
function themeList() { return themes.list(); }
function themeSelect(a) { return themes.select(a && a.id); }
function themesDir() { return themes.themesDir(); }

function hostMemory() { return livestats.hostMemory(); }

// ---- Clip recorder ----
// Clips land in the instance's screenshots/ folder as clip-<n>.gif with a
// clip-<n>.png poster beside it, so the existing gallery (which lists png/jpg)
// surfaces the clip too instead of it being invisible until you open Finder.
function nextClipPaths(instanceId) {
  const inst = readInstances().find((i) => i.id === instanceId);
  if (!inst) throw new Error("Instance not found.");
  const dir = path.join(install.paths(DATA_DIR).instanceDir(inst.id), "screenshots");
  fs.mkdirSync(dir, { recursive: true });
  let n = 1;
  while (fs.existsSync(path.join(dir, `clip-${n}.gif`))) n++;
  return { dir, gif: path.join(dir, `clip-${n}.gif`), poster: path.join(dir, `clip-${n}.png`), name: `clip-${n}.gif` };
}

function saveClip(a) {
  const { gif, poster, name, dir } = nextClipPaths(a.instanceId);
  fs.writeFileSync(gif, Buffer.from(a.gifBase64, "base64"));
  if (a.posterBase64) fs.writeFileSync(poster, Buffer.from(a.posterBase64, "base64"));
  return { path: gif, name, dir, size: fs.statSync(gif).size };
}

// Is this instance running, and under which pid? The clip UI needs to know
// whether there is even a game window to record.
function runningPid(instanceId) {
  const r = running[instanceId];
  return r && r.pid ? r.pid : null;
}

module.exports = {
  publishInstance, hostMemory, saveClip, runningPid,
  themeList, themeSelect, themesDir,
  pluginList, pluginSetEnabled, pluginRemove, pluginInstall, pluginCommunity,
  pluginTabs, pluginThemes, pluginMainScript, pluginGetData, pluginSetData,
  pluginsDir, pluginReadFile,
  playitStatus, playitSetSecret, playitStart, playitStop,
  exarotonConnect, exarotonDisconnect, exarotonStatus, exarotonRefresh,
  exarotonStart, exarotonStop, exarotonRestart, exarotonCommand, exarotonLogs, exarotonPushMods,
  init, setEmitter, setTrash, dataDir, info,   // [wave0] setTrash
  getSettings, setSettings,
  listInstances, createInstance, deleteInstance, updateInstance,
  listVersions, modrinthSearch, curseforgeSearch,
  installContent, installCurseforgeContent, listContent, removeContent,
  modrinthProject, curseforgeProject,
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

  // ---- LAN worlds (passive multicast listener) ----
  lanStart: () => lan.start(),
  lanStop: () => lan.stop(),
  lanList: () => lan.list(),

  // ---- Per-instance notes + links ----
  // Kept beside the instance rather than inside instances.json so a long note
  // never bloats the file every launch rewrites.
  instanceNotes: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    const file = path.join(install.paths(DATA_DIR).instanceDir(inst.id), "lodestone-notes.json");
    try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return { note: j.note || "", links: j.links || [] }; }
    catch { return { note: "", links: [] }; }
  },
  setInstanceNotes: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    const file = path.join(install.paths(DATA_DIR).instanceDir(inst.id), "lodestone-notes.json");
    const current = (() => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { note: "", links: [] }; } })();
    if (a.note !== undefined) current.note = String(a.note);
    if (Array.isArray(a.links)) {
      // Only http(s) links are stored — a file:// or javascript: URL here would
      // be handed straight to the shell when opened.
      current.links = a.links
        .filter((l) => l && /^https?:\/\//i.test(l.url || ""))
        .slice(0, 50)
        .map((l) => ({ label: String(l.label || l.url).slice(0, 120), url: String(l.url) }));
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(current, null, 2));
    return current;
  },

  // ---- Notifications ----
  // A durable feed of things worth telling the user about. Written by the
  // engine, read and dismissed by the sidebar.
  notifications: () => readNotifications(),
  dismissNotification: (a) => {
    const list = readNotifications().filter((n) => n.id !== (a && a.id));
    writeNotifications(list);
    return list;
  },
  clearNotifications: () => { writeNotifications([]); return []; },

  // ---- Play history / heatmap / wrapped / achievements ----
  // All four read the same session log. Nothing is estimated: a day with no
  // session simply has no entry, rather than being interpolated.
  sessions: (a) => {
    const all = readSessions();
    const rows = a && a.instanceId ? all.filter((s) => s.instanceId === a.instanceId) : all;
    return rows.sort((x, y) => (y.endedAt || 0) - (x.endedAt || 0)).slice(0, (a && a.limit) || 500);
  },
  playHeatmap: (a) => {
    const days = (a && a.days) || 365;
    const cutoff = Date.now() - days * 86400_000;
    const byDay = {};
    for (const s of readSessions()) {
      if (!s.endedAt || s.endedAt < cutoff) continue;
      const key = new Date(s.endedAt).toISOString().slice(0, 10);
      byDay[key] = (byDay[key] || 0) + (s.ms || 0);
    }
    const max = Math.max(0, ...Object.values(byDay));
    return { byDay, max, days };
  },
  playWrapped: (a) => {
    const year = (a && a.year) || new Date().getFullYear();
    const rows = readSessions().filter((s) => new Date(s.endedAt || 0).getFullYear() === year);
    const names = new Map(readInstances().map((i) => [i.id, i.name]));
    const byInstance = {};
    const byHour = new Array(24).fill(0);
    const days = new Set();
    let total = 0, longest = null;
    for (const s of rows) {
      total += s.ms || 0;
      byInstance[s.instanceId] = (byInstance[s.instanceId] || 0) + (s.ms || 0);
      byHour[new Date(s.startedAt || s.endedAt).getHours()] += s.ms || 0;
      days.add(new Date(s.endedAt).toISOString().slice(0, 10));
      if (!longest || (s.ms || 0) > longest.ms) longest = s;
    }
    const top = Object.entries(byInstance)
      .map(([id, ms]) => ({ id, name: names.get(id) || "Deleted instance", ms }))
      .sort((x, y) => y.ms - x.ms);
    let peakHour = 0;
    byHour.forEach((v, h) => { if (v > byHour[peakHour]) peakHour = h; });
    return { year, total, sessions: rows.length, daysPlayed: days.size, top, peakHour,
             longest: longest ? { ms: longest.ms, when: longest.endedAt, name: names.get(longest.instanceId) || null } : null,
             hasData: rows.length > 0 };
  },
  achievements: () => {
    const instances = readInstances();
    const sessions = readSessions();
    const totalMs = instances.reduce((n, i) => n + (Number(i.playtimeMs) || 0), 0);
    const days = new Set(sessions.map((s) => new Date(s.endedAt || 0).toISOString().slice(0, 10)));
    const modTotal = instances.reduce((n, i) => n + (i.mods || 0), 0);
    const longest = sessions.reduce((m, s) => Math.max(m, s.ms || 0), 0);
    // Every one of these is measured from real data; none are aspirational.
    const defs = [
      { id: "first", name: "First launch", desc: "Play an instance once.", got: sessions.length >= 1, progress: Math.min(1, sessions.length) },
      { id: "packrat", name: "Pack rat", desc: "Keep five instances at once.", got: instances.length >= 5, progress: instances.length / 5 },
      { id: "modded", name: "Modded", desc: "Install 100 mods in total.", got: modTotal >= 100, progress: modTotal / 100 },
      { id: "tenhours", name: "Invested", desc: "Play for ten hours.", got: totalMs >= 36e6, progress: totalMs / 36e6 },
      { id: "hundred", name: "Devoted", desc: "Play for a hundred hours.", got: totalMs >= 36e7, progress: totalMs / 36e7 },
      { id: "marathon", name: "Marathon", desc: "Play a single session of four hours.", got: longest >= 144e5, progress: longest / 144e5 },
      { id: "week", name: "Regular", desc: "Play on seven different days.", got: days.size >= 7, progress: days.size / 7 },
      { id: "month", name: "Committed", desc: "Play on thirty different days.", got: days.size >= 30, progress: days.size / 30 },
    ];
    return { achievements: defs.map((d) => ({ ...d, progress: Math.max(0, Math.min(1, d.progress)) })),
             unlocked: defs.filter((d) => d.got).length, total: defs.length };
  },

  // ---- Server ops: live stats, access lists, plugins ----
  serverStats: (a) => serverEngine.stats(DATA_DIR, a && a.id),
  serverAccess: (a) => serverEngine.accessList(DATA_DIR, a && a.id),
  serverAccessChange: (a) => serverEngine.accessChange(DATA_DIR, a && a.id, a),
  serverPlugins: (a) => serverEngine.plugins(DATA_DIR, a && a.id),
  serverPluginToggle: (a) => serverEngine.setPluginEnabled(DATA_DIR, a && a.id, a),

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
  // Manual order. Instances without an explicit order keep sorting by
  // last-played, so an untouched library behaves exactly as before.
  reorderInstances: (a) => {
    const order = Array.isArray(a && a.order) ? a.order : [];
    const list = readInstances();
    order.forEach((id, i) => {
      const inst = list.find((x) => x.id === id);
      if (inst) inst.sortIndex = i;
    });
    writeInstances(list);
    return listInstances();
  },
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
  seedMap: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    const modsDir = inst ? path.join(install.paths(DATA_DIR).instanceDir(inst.id), "mods") : null;
    return seedfinder.map({
      mcVersion: (inst && inst.mcVersion) || a.mcVersion,
      seed: a && a.seed, radius: a && a.radius, step: a && a.step, modsDir,
    });
  },
  // ---- Forever Worlds ----
  // A world you commit to: an instance plus a server whose settings are baked
  // in at creation and never editable afterwards. Entering starts the server in
  // the background and joins it on localhost, so the world lives server-side
  // and survives client changes, mod swaps and reinstalls.
  createForeverWorld: async (a) => {
    const name = String((a && a.name) || "").trim() || "Forever World";
    const loader = (a && a.loader) || "vanilla";
    const inst = createInstance({ name, mcVersion: a.mcVersion, loader });

    const platform = loader === "fabric" ? "fabric" : loader === "vanilla" ? "vanilla" : "paper";
    const server = await serverEngine.create(DATA_DIR, {
      name, platform, mcVersion: a.mcVersion,
    }, { onLog: (line) => emit("launch:log", { line }) });

    // Bake the locked settings in now. They are deliberately not editable
    // later — that is the whole promise of a Forever World.
    serverEngine.setProperties(DATA_DIR, server.id, {
      "level-name": "world",
      "level-seed": String((a && a.seed) || ""),
      difficulty: String((a && a.difficulty) || "normal"),
      hardcore: a && a.hardcore ? "true" : "false",
      "level-type": String((a && a.levelType) || "minecraft:normal"),
      "online-mode": "false",     // joined over localhost by its own owner
      motd: name,
    });

    const list = readInstances();
    const rec = list.find((i) => i.id === inst.id);
    if (rec) { rec.foreverServerId = server.id; rec.isForever = true; writeInstances(list); }

    const servers = serverEngine.list(DATA_DIR);
    const srec = servers.find((x) => x.id === server.id);
    return { instance: rec || inst, server: srec || server };
  },

  listForeverWorlds: () => {
    const servers = serverEngine.list(DATA_DIR);
    return readInstances().filter((i) => i.isForever).map((i) => ({
      instanceId: i.id, name: i.name, mcVersion: i.mcVersion, loader: i.loader,
      serverId: i.foreverServerId,
      running: !!(servers.find((s) => s.id === i.foreverServerId) || {}).running,
      playtimeMs: i.playtimeMs || 0,
    }));
  },

  // Start the locked server, wait for it to say it is ready, then launch the
  // client straight into it. Waiting matters: joining before the server is up
  // drops the player on a connection-refused screen.
  enterForeverWorld: (a) => new Promise((resolve, reject) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst || !inst.foreverServerId) { reject(new Error("Not a Forever World.")); return; }
    const props = serverEngine.properties(DATA_DIR, inst.foreverServerId);
    const port = Number(props["server-port"]) || 25565;

    let joined = false;
    const join = async () => {
      if (joined) return;
      joined = true;
      try { resolve(await launch(inst.id, { joinServer: `127.0.0.1:${port}` })); }
      catch (e) { reject(e); }
    };

    serverEngine.start(DATA_DIR, inst.foreverServerId, {
      onLog: (line) => {
        emit("server:log", { id: inst.foreverServerId, line });
        if (/\bDone \([\d.]+s\)!/.test(line)) join();
      },
      onState: (st) => emit("server:state", st),
    }).catch(reject);

    // If the server never announces readiness, say so rather than hanging.
    setTimeout(() => {
      if (!joined) { joined = true; reject(new Error("The world's server didn't start in time. Check the Servers tab.")); }
    }, 180_000);
  }),

  deleteForeverWorld: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst || !inst.isForever) throw new Error("Not a Forever World.");
    if (inst.foreverServerId) { try { serverEngine.remove(DATA_DIR, inst.foreverServerId); } catch { /* already gone */ } }
    deleteInstance(inst.id);
    return { deleted: true };
  },

  // ---- Chunk pregeneration ----
  pregenStatus: () => pregen.status(),
  pregenStop: () => pregen.stop(pregenDeps()),
  pregenResult: () => pregen.result(pregenDeps()),
  pregenStart: (a) => pregen.start({
    instanceId: a && a.instanceId,
    radius: a && a.radius,
    world: (a && a.world) || "world",
    deps: pregenDeps(),
    onLog: (line) => emit("pregen:log", { line }),
    onState: (st) => emit("pregen:state", st),
  }),

  // ---- CurseForge cleanup ----
  // CurseForge content is recorded with a cf: id. This finds the records that
  // can no longer be acted on — jar gone, or a project id that no longer
  // resolves — so they can be cleared rather than sitting there pretending the
  // mod is installed.
  curseforgeAudit: async (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    const modsDir = path.join(install.paths(DATA_DIR).instanceDir(inst.id), "mods");
    let files = [];
    try { files = fs.readdirSync(modsDir); } catch { files = [] }
    const present = new Set(files);

    const cf = (inst.content || []).filter((c) => /^cf[:-]/i.test(String(c.projectId || "")) || c.source === "curseforge");
    const rows = [];
    for (const c of cf) {
      const onDisk = present.has(c.fileName) || present.has(c.fileName + ".disabled");
      rows.push({ projectId: c.projectId, title: c.title || c.fileName, fileName: c.fileName,
                  onDisk, issue: onDisk ? null : "file missing" });
    }

    // Jars that no record claims: usually left behind by a failed install or
    // dropped in by hand. Reported, never deleted automatically.
    const claimed = new Set((inst.content || []).map((c) => c.fileName));
    const orphans = files.filter((f) => /\.jar$/i.test(f) && !claimed.has(f))
      .map((f) => ({ fileName: f, issue: "not tracked by any record" }));

    return { tracked: rows, orphans, hasKey: !!settings.getSettings().curseforgeKey };
  },

  // ---- Scheduled world backups ----
  // Runs on a timer while the launcher is open, and prunes old zips so this
  // cannot quietly fill the disk. Never backs up an instance that is running:
  // zipping a world mid-write produces a corrupt archive that looks fine.
  backupSettings: () => readBackupSettings(),
  setBackupSettings: (a) => {
    const cur = readBackupSettings();
    if (a.enabled !== undefined) cur.enabled = !!a.enabled;
    if (a.everyHours !== undefined) {
      const n = Number(a.everyHours);
      cur.everyHours = Number.isFinite(n) ? Math.max(1, Math.min(168, Math.round(n))) : 12;
    }
    if (a.keep !== undefined) {
      const n = Number(a.keep);
      cur.keep = Number.isFinite(n) ? Math.max(1, Math.min(50, Math.round(n))) : 5;
    }
    writeBackupSettings(cur);
    restartBackupTimer();
    return cur;
  },
  runBackupsNow: () => runScheduledBackups(true),

  // ---- Instance health ----
  // Everything that can be checked without launching. Each finding names what
  // is wrong and what to do; nothing is reported as a problem unless it is one.
  instanceHealth: (a) => {
    const inst = readInstances().find((i) => i.id === (a && a.instanceId));
    if (!inst) throw new Error("Instance not found.");
    const dir = install.paths(DATA_DIR).instanceDir(inst.id);
    const modsDir = path.join(dir, "mods");
    const findings = [];

    let jars = [];
    try { jars = fs.readdirSync(modsDir); } catch { jars = []; }
    const enabled = jars.filter((f) => /\.jar$/i.test(f));
    const disabled = jars.filter((f) => /\.jar\.disabled$/i.test(f));

    // Content records whose jar is gone: the pack thinks a mod is installed
    // and the game will not load it.
    const onDisk = new Set(enabled);
    const missing = (inst.content || []).filter((c) => (c.kind || "mod") === "mod" && !onDisk.has(c.fileName)
      && !disabled.includes(c.fileName + ".disabled"));
    if (missing.length) {
      findings.push({ level: "error", title: `${missing.length} mod${missing.length === 1 ? "" : "s"} missing from disk`,
        detail: missing.slice(0, 5).map((m) => m.title || m.fileName).join(", "),
        fix: "repair", fixLabel: "Reinstall missing" });
    }

    // Two jars of the same mod at different versions load both and usually crash.
    const byBase = {};
    for (const f of enabled) {
      const base = f.replace(/\.jar$/i, "").replace(/[-_]?(v)?\d[\d.+\w-]*$/i, "").toLowerCase();
      if (!base) continue;
      (byBase[base] = byBase[base] || []).push(f);
    }
    const dupes = Object.values(byBase).filter((g) => g.length > 1);
    if (dupes.length) {
      findings.push({ level: "error", title: `${dupes.length} mod${dupes.length === 1 ? "" : "s"} installed twice`,
        detail: dupes.slice(0, 3).map((g) => g.join(" + ")).join("  |  "),
        fix: null, fixLabel: null });
    }

    if (disabled.length) {
      findings.push({ level: "info", title: `${disabled.length} mod${disabled.length === 1 ? "" : "s"} disabled`,
        detail: "They stay on disk and load again when re-enabled.", fix: null });
    }

    // A modded instance with no loader will boot vanilla and load nothing.
    if (enabled.length && inst.loader === "vanilla") {
      findings.push({ level: "error", title: "Mods present but the loader is Vanilla",
        detail: "Vanilla Minecraft cannot load mods. Change the loader in Settings.", fix: null });
    }

    // RAM that is too low for the pack size is the most common silent crash.
    const ram = inst.ramMB || settings.getSettings().defaultRamMB || 0;
    if (enabled.length > 120 && ram && ram < 6144) {
      findings.push({ level: "warn", title: "Memory may be too low for this pack",
        detail: `${enabled.length} mods with ${(ram / 1024).toFixed(1)} GB allocated. Large packs usually want 6 GB or more.`,
        fix: null });
    }

    let sizeBytes = 0;
    try { sizeBytes = files.dirSize(dir); } catch { sizeBytes = 0; }

    return {
      ok: !findings.some((f) => f.level === "error"),
      findings,
      mods: enabled.length,
      disabled: disabled.length,
      size: sizeBytes,
      ramMB: ram || null,
    };
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
  skinList: () => globalsetup.listSkins(),
  skinSave: (a) => globalsetup.saveSkin(a),
  skinRemove: (a) => globalsetup.removeSkin(a),
  skinRename: (a) => globalsetup.renameSkin(a),
  skinApply: async (a) => { const ses = await auth.currentSession(); return globalsetup.applySkin({ token: ses && ses.accessToken, id: a && a.id }); },
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
const publish = require("./publish");
const exaroton = require("./exaroton");
const playit = require("./playit");
const plugins = require("./plugins");
const themes = require("./themes");
const livestats = require("./livestats");

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
