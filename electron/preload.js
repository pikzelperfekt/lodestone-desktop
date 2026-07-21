// Safe bridge: exposes the engine's JSON API + launch events to the renderer (web/)
// without giving it Node access. The web UI calls window.lodestone.* and falls back
// to sample data when this bridge is absent (plain browser).
const { contextBridge, ipcRenderer } = require("electron");

const call = (channel, args) => ipcRenderer.invoke(channel, args);

contextBridge.exposeInMainWorld("lodestone", {
  isDesktop: true,
  info: () => call("engine:info"),
  instances: {
    list: () => call("instances:list"),
    create: (opts) => call("instances:create", opts),
    update: (opts) => call("instance:update", opts),
    delete: (id) => call("instances:delete", { id }),
  },
  versions: () => call("versions:list"),
  modrinthSearch: (opts) => call("modrinth:search", opts),
  content: {
    install: (opts) => call("content:install", opts),
    list: (instanceId) => call("content:list", { instanceId }),
    remove: (opts) => call("content:remove", opts),
  },
  importModpack: (path) => call("import:mrpack", { path }),
  worlds: {
    list: (instanceId) => call("worlds:list", { instanceId }),
    backups: (instanceId) => call("worlds:backups", { instanceId }),
    backup: (opts) => call("worlds:backup", opts),
    restore: (opts) => call("worlds:restore", opts),
    rename: (opts) => call("worlds:rename", opts),
    remove: (opts) => call("worlds:remove", opts),
  },
  launch: (id) => call("launch", { id }),
  stop: (id) => call("launch:stop", { id }),
  account: {
    get: () => call("account:get"),
    signOut: () => call("account:signOut"),
    start: () => call("auth:start"),
    complete: (device) => call("auth:complete", { device }),
  },
  openDataDir: () => call("open:dataDir"),
  openExternal: (url) => call("open:external", { url }),
  // App settings (memory / Java override / launcher behavior).
  settings: {
    get: () => call("settings:get"),
    set: (patch) => call("settings:set", patch),
  },
  // Auto-update: subscribe to state, ask for a check, or install a downloaded update.
  update: {
    check: () => call("update:check"),
    install: () => call("update:install"),
  },
  // Launch + update lifecycle events.
  on: (channel, fn) => {
    const allowed = ["launch:progress", "launch:log", "launch:state", "update:state", "content:log"];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
