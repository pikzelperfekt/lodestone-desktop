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
    backgroundColor: "#06080B",
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
handle("versions:list", () => engine.listVersions());
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
ipcMain.handle("open:dataDir", () => shell.openPath(engine.dataDir()));
ipcMain.handle("open:external", (_e, a) => shell.openExternal(a.url));

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

app.whenReady().then(() => {
  engine.init(app.getPath("userData"));
  engine.setEmitter((channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); });
  createWindow();
  setupUpdates();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
