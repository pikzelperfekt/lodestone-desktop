// Lodestone desktop (Electron). The main process hosts the "engine" — the
// cross-platform stand-in for the Swift sidecar. It exposes a small JSON API over
// IPC that the web UI (web/) calls, and drives auto-updates via electron-updater
// (GitHub Releases feed configured in package.json's build.publish).
const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("path");
const { autoUpdater } = require("electron-updater");
const engine = require("./engine");

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: "#0C0F14",   // --deepslate-0 (web/design-tokens.css)
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    title: "Lodestone",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "..", "web", "index.html"));
}

// ---- Engine IPC surface (mirrors the planned sidecar JSON API) ----
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, args) => {
    try {
      return { ok: true, data: await fn(args || {}) };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
}

handle("engine:info", () => engine.info());
handle("instances:list", () => engine.listInstances());
handle("instances:create", (a) => engine.createInstance(a));
handle("instance:update", (a) => engine.updateInstance(a));
handle("instances:delete", (a) => engine.deleteInstance(a.id));
handle("instance:repair", (a) => engine.repairInstance(a.id));
handle("instance:updateAll", (a) => engine.updateAllContent(a.id));
handle("versions:list", (a) => engine.listVersions(a)); // [wave0] a.channels opts in to snapshots/old versions
handle("modrinth:search", (a) => engine.modrinthSearch(a));
handle("curseforge:search", (a) => engine.curseforgeSearch(a));
handle("content:install", (a) => engine.installContent(a));
handle("content:installCurseforge", (a) => engine.installCurseforgeContent(a));
handle("content:list", (a) => engine.listContent(a.instanceId));
handle("content:remove", (a) => engine.removeContent(a));
handle("import:mrpack", async (a) => {
  let filePath = a && a.path;
  if (!filePath) {
    const res = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [
        { name: "Modpack", extensions: ["mrpack", "zip"] },
        { name: "Modrinth modpack", extensions: ["mrpack"] },
        { name: "CurseForge modpack", extensions: ["zip"] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return null;
    filePath = res.filePaths[0];
  }
  return engine.importModpack(filePath);
});
handle("share:code", (a) => engine.exportInstanceCode(a.id));
handle("share:sync", (a) => engine.syncInstanceFromCode(a));
handle("share:create", (a) => engine.createInstanceFromCode(a.code));
handle("share:mrpack", async (a) => {
  const base = String((a && a.name) || "modpack").replace(/[\\/:*?"<>|]+/g, " ").trim() || "modpack";
  const res = await dialog.showSaveDialog(win, {
    title: "Export modpack (.mrpack)",
    defaultPath: `${base}.mrpack`,
    filters: [{ name: "Modrinth modpack", extensions: ["mrpack"] }],
  });
  if (res.canceled || !res.filePath) return null;
  return engine.exportInstanceMrpack(a.id, res.filePath);
});
handle("worlds:list", (a) => engine.worldList(a.instanceId));
handle("worlds:backups", (a) => engine.worldBackups(a.instanceId));
handle("worlds:backup", (a) => engine.worldBackup(a));
handle("worlds:restore", (a) => engine.worldRestore(a));
handle("worlds:rename", (a) => engine.worldRename(a));
handle("worlds:remove", (a) => engine.worldRemove(a));
handle("launch", (a) => engine.launch(a.id));
handle("launch:stop", (a) => engine.stop(a.id));
handle("servers:list", () => engine.listServers());
handle("servers:create", (a) => engine.createServer(a));
handle("servers:start", (a) => engine.startServer(a.id));
handle("servers:stop", (a) => engine.stopServer(a.id));
handle("servers:command", (a) => engine.serverCommand(a));
handle("servers:properties", (a) => engine.serverProperties(a.id));
handle("servers:setProperties", (a) => engine.setServerProperties(a));
handle("servers:hosting", (a) => engine.serverHostingInfo(a.id));
handle("servers:onlineMode", (a) => engine.setServerOnlineMode(a));
handle("servers:remove", (a) => engine.removeServer(a.id));
handle("settings:get", () => engine.getSettings());
handle("settings:set", (a) => engine.setSettings(a));
handle("account:get", () => engine.account());
handle("account:signOut", () => engine.signOut());
handle("auth:start", () => engine.signInStart());
handle("auth:complete", (a) => engine.signInComplete(a.device));
// Lodestone cloud account (social/sync identity — separate from the MC account).
handle("cloud:status", () => engine.cloudStatus());
handle("cloud:signUp", (a) => engine.cloudSignUp(a));
handle("cloud:signIn", (a) => engine.cloudSignIn(a));
handle("cloud:signOut", () => engine.cloudSignOut());
handle("cloud:profile", () => engine.cloudProfile());
handle("cloud:updateProfile", (a) => engine.cloudUpdateProfile(a));
handle("cloud:linkMinecraft", () => engine.cloudLinkMinecraft());
handle("cloud:searchProfiles", (a) => engine.cloudSearchProfiles(a));
// [Cloud Sync — Vertical A] instance manifests ⇄ synced_instances.
handle("cloud:sync:push", (a) => engine.cloudSyncPush(a));
handle("cloud:sync:list", () => engine.cloudSyncList());
handle("cloud:sync:pull", (a) => engine.cloudSyncPull(a));
handle("cloud:sync:remove", (a) => engine.cloudSyncRemove(a));
handle("cloud:sync:status", (a) => engine.cloudSyncStatus(a));
// Shared packs — one permanent code, live propagation to every member.
handle("pack:share", (a) => engine.packShare(a));
handle("pack:join", (a) => engine.packJoin(a));
handle("pack:publish", (a) => engine.packPublish(a));
handle("pack:list", () => engine.packList());
handle("pack:status", (a) => engine.packStatus(a));
handle("pack:setMode", (a) => engine.packSetMode(a));
handle("pack:invite", (a) => engine.packInvite(a));
handle("pack:members", (a) => engine.packMembers(a));
handle("pack:leave", (a) => engine.packLeave(a));
// Global SETUP screens: Game settings, Keybinds profile, Skins.
handle("setup:game:get", () => engine.gameSettingsGet());
handle("setup:game:set", (a) => engine.gameSettingsSet(a));
handle("setup:game:apply", (a) => engine.gameSettingsApply(a));
handle("setup:keybinds:get", () => engine.keybindProfileGet());
handle("setup:keybinds:set", (a) => engine.keybindProfileSet(a));
handle("setup:keybinds:reset", () => engine.keybindProfileReset());
handle("setup:keybinds:disabled", (a) => engine.keybindDisabled(a));
handle("setup:keybinds:apply", (a) => engine.keybindApply(a));
handle("setup:keybinds:preset", (a) => engine.keybindPreset(a));
handle("setup:keybinds:refresh", () => engine.keybindRefresh());
handle("setup:skin:profile", () => engine.skinProfile());
handle("setup:skin:upload", (a) => engine.skinUpload(a));
handle("setup:skin:reset", () => engine.skinReset());
// Worlds: create a fresh world, or import a folder / .zip of one.
handle("mixins:scan", (a) => engine.scanMixins(a));
handle("instances:sizes", () => engine.instanceSizes());
handle("mods:list", (a) => engine.listMods(a));
handle("storage:read", () => engine.storage());
handle("storage:reclaim", (a) => engine.reclaim(a));
handle("files:list", (a) => engine.browseFiles(a));
handle("files:read", (a) => engine.readFile(a));
handle("files:write", (a) => engine.writeFile(a));
handle("configs:list", (a) => engine.listConfigs(a));
handle("worlds:info", (a) => engine.worldInfo(a));
handle("worlds:scan", (a) => engine.worldScan(a));
handle("lan:start", () => engine.lanStart());
handle("lan:stop", () => engine.lanStop());
handle("lan:list", () => engine.lanList());
handle("notes:get", (a) => engine.instanceNotes(a));
handle("notes:set", (a) => engine.setInstanceNotes(a));
handle("notify:list", () => engine.notifications());
handle("notify:dismiss", (a) => engine.dismissNotification(a));
handle("notify:clear", () => engine.clearNotifications());
handle("stats:sessions", (a) => engine.sessions(a));
handle("stats:heatmap", (a) => engine.playHeatmap(a));
handle("stats:wrapped", (a) => engine.playWrapped(a));
handle("stats:achievements", () => engine.achievements());
handle("servers:stats", (a) => engine.serverStats(a));
handle("servers:access", (a) => engine.serverAccess(a));
handle("servers:accessChange", (a) => engine.serverAccessChange(a));
handle("servers:plugins", (a) => engine.serverPlugins(a));
handle("servers:pluginToggle", (a) => engine.serverPluginToggle(a));
handle("groups:list", () => engine.listGroups());
handle("groups:save", (a) => engine.saveGroup(a));
handle("groups:delete", (a) => engine.deleteGroup(a));
handle("groups:assign", (a) => engine.setInstanceGroup(a));
handle("shots:list", (a) => engine.listScreenshots(a));
handle("logs:read", (a) => engine.readInstanceLog(a));
handle("loader:bridge", (a) => engine.loaderBridge(a));
handle("mods:toggle", (a) => engine.toggleMod(a));
handle("seed:available", () => engine.seedSearchAvailable());
handle("seed:search", (a) => engine.seedSearch(a));
handle("worlds:create", (a) => engine.createWorld(a));
handle("worlds:import", async (a) => {
  let source = a && a.source;
  if (!source) {
    const res = await dialog.showOpenDialog(win, {
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "Minecraft world (.zip)", extensions: ["zip"] }],
      message: "Pick a world folder, or a .zip of one",
    });
    if (res.canceled || !res.filePaths.length) return null;
    source = res.filePaths[0];
  }
  return engine.importWorld({ instanceId: a && a.instanceId, source });
});
// Friends + Presence (Vertical B — social.js).
handle("cloud:friends:list", () => engine.friendsList());
handle("cloud:friends:search", (a) => engine.friendsSearch(a));
handle("cloud:friends:request", (a) => engine.friendsRequest(a));
handle("cloud:friends:respond", (a) => engine.friendsRespond(a));
handle("cloud:friends:remove", (a) => engine.friendsRemove(a));
handle("cloud:friends:block", (a) => engine.friendsBlock(a));
handle("cloud:friends:setActivity", (a) => engine.friendsSetActivity(a));
// Chat + Squads (Vertical C) — squad channels + direct messages; live over "cloud:message".
handle("cloud:createSquad", (a) => engine.chatCreateSquad(a));
handle("cloud:joinSquad", (a) => engine.chatJoinSquad(a));
handle("cloud:leaveSquad", (a) => engine.chatLeaveSquad(a));
handle("cloud:listSquads", () => engine.chatListSquads());
handle("cloud:squadInvite", (a) => engine.chatSquadInvite(a));
handle("cloud:startDm", (a) => engine.chatStartDm(a));
handle("cloud:listDMs", () => engine.chatListDMs());
handle("cloud:chatHistory", (a) => engine.chatHistory(a));
handle("cloud:chatSend", (a) => engine.chatSend(a));
// [Crash Doctor] — crash scan + apply-fix + the persistent mod bisect (doctor.js).
handle("doctor:scan", (a) => engine.doctorScan(a.instanceId));
handle("doctor:fix", (a) => engine.doctorFix(a));
handle("doctor:bisect:status", (a) => engine.doctorBisectStatus(a.instanceId));
handle("doctor:bisect:start", (a) => engine.doctorBisectStart(a.instanceId));
handle("doctor:bisect:report", (a) => engine.doctorBisectReport(a));
handle("doctor:bisect:abort", (a) => engine.doctorBisectAbort(a));
ipcMain.handle("open:dataDir", () => shell.openPath(engine.dataDir()));
ipcMain.handle("open:external", (_e, a) => shell.openExternal(a.url));

// ============================================================================
// [Content managers vertical] resource packs / shaders / datapacks + keybinds.
// ============================================================================
handle("packs:resourcepacks", (a) => engine.packsResourcePacks(a));
handle("packs:resourcepacks:set", (a) => engine.packsResourceSet(a));
handle("packs:resourcepacks:reorder", (a) => engine.packsResourceReorder(a));
handle("packs:shaders", (a) => engine.packsShaders(a));
handle("packs:shaders:select", (a) => engine.packsShaderSelect(a));
handle("packs:datapacks", (a) => engine.packsDatapacks(a));
handle("packs:delete", (a) => engine.packsDelete(a));
// Import one or more .zip packs. Without explicit paths, a file picker opens.
handle("packs:import", async (a) => {
  let files = (a && a.paths) || null;
  if (!files || !files.length) {
    const kindLabel = a && a.kind === "shader" ? "Shader pack" : a && a.kind === "datapack" ? "Datapack" : "Resource pack";
    const res = await dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: `${kindLabel} (.zip)`, extensions: ["zip"] }],
    });
    if (res.canceled || !res.filePaths.length) return null;
    files = res.filePaths;
  }
  const imported = [];
  for (const filePath of files) {
    imported.push(await engine.packsImport({ instanceId: a.instanceId, kind: a.kind, world: a.world, filePath }));
  }
  return imported;
});
handle("packs:openFolder", (a) => shell.openPath(engine.packsFolderPath(a)));
handle("keybinds:list", (a) => engine.keybindsList(a));
handle("keybinds:set", (a) => engine.keybindsSet(a));
handle("keybinds:reset", (a) => engine.keybindsReset(a));
handle("keybinds:resetAll", (a) => engine.keybindsResetAll(a));

// ---- Auto-update (electron-updater over the GitHub Releases feed) ----
// Only meaningful in a packaged, installed build; a dev run has no version to update.
function sendUpdate(payload) { if (win && !win.isDestroyed()) win.webContents.send("update:state", payload); }

function setupUpdates() {
  autoUpdater.autoDownload = true;          // pull the new version in the background
  autoUpdater.autoInstallOnAppQuit = true;  // apply it on next quit if the user doesn't restart now
  autoUpdater.on("checking-for-update", () => sendUpdate({ status: "checking" }));
  autoUpdater.on("update-available", (info) => sendUpdate({ status: "downloading", version: info.version, percent: 0 }));
  autoUpdater.on("update-not-available", () => sendUpdate({ status: "current" }));
  autoUpdater.on("download-progress", (p) => sendUpdate({ status: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => sendUpdate({ status: "ready", version: info.version }));
  autoUpdater.on("error", (err) => sendUpdate({ status: "error", message: String(err && err.message ? err.message : err) }));

  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000); // re-check every 6h
  }
}

// Renderer-triggered update actions.
ipcMain.handle("update:check", () => (app.isPackaged ? autoUpdater.checkForUpdates().catch(() => null) : null));
ipcMain.handle("update:install", () => { autoUpdater.quitAndInstall(); });

// ============================================================================
// [Icons + .lodepack — vertical feat/win-icons-lodepack] — additive section.
// Unified pack import (.mrpack / CurseForge .zip / .lodepack v1+v2), .lodepack
// export, and per-instance icons (image decode/resize happens here with
// nativeImage; the engine only ever sees bytes).
const { nativeImage } = require("electron");

handle("import:pack", async (a) => {
  let filePath = a && a.path;
  if (!filePath) {
    const res = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [
        { name: "Modpacks", extensions: ["mrpack", "zip", "lodepack"] },
        { name: "Lodestone pack", extensions: ["lodepack"] },
        { name: "Modrinth modpack", extensions: ["mrpack"] },
        { name: "CurseForge modpack", extensions: ["zip"] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return null;
    filePath = res.filePaths[0];
  }
  return engine.importAnyPack(filePath);
});

handle("share:lodepack", async (a) => {
  const base = String((a && a.name) || "pack").replace(/[\\/:*?"<>|]+/g, " ").trim() || "pack";
  const res = await dialog.showSaveDialog(win, {
    title: "Export Lodestone pack (.lodepack)",
    defaultPath: `${base}.lodepack`,
    filters: [{ name: "Lodestone pack", extensions: ["lodepack"] }],
  });
  if (res.canceled || !res.filePath) return null;
  return engine.exportInstanceLodepack(a.id, res.filePath);
});

// Pick an image file, center-crop it square, resize to 256px, store as icon.png.
handle("icon:pick", async (a) => {
  const res = await dialog.showOpenDialog(win, {
    title: "Choose an instance icon",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const img = nativeImage.createFromPath(res.filePaths[0]);
  if (!img || img.isEmpty()) throw new Error("Couldn't read that image — use a .png or .jpg file.");
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  const square = img.crop({
    x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2),
    width: side, height: side,
  });
  const png = square.resize({ width: 256, height: 256 }).toPNG();
  return engine.setInstanceIcon({ id: a.id, dataBase64: png.toString("base64"), ext: "png" });
});
// Raw PNG bytes from the renderer (the built-in generated tile set).
handle("icon:set", (a) => engine.setInstanceIcon(a));
handle("icon:remove", (a) => engine.removeInstanceIcon(a));
// ============================================================================

app.whenReady().then(() => {
  engine.init(app.getPath("userData"));
  engine.setEmitter((channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); });
  // [wave0] Trash-tier deletes: worlds + resource/shader/datapacks are recoverable
  // via the OS Recycle Bin (Mac parity); instances/servers stay permanent.
  engine.setTrash((p) => shell.trashItem(p));
  createWindow();
  setupUpdates();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
