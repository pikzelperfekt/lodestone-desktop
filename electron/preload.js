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
    delete: (id) => call("instances:delete", { id }),
  },
  versions: () => call("versions:list"),
  modrinthSearch: (opts) => call("modrinth:search", opts),
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
  // Auto-update: subscribe to state, ask for a check, or install a downloaded update.
  update: {
    check: () => call("update:check"),
    install: () => call("update:install"),
  },
  // Launch + update lifecycle events.
  on: (channel, fn) => {
    const allowed = ["launch:progress", "launch:log", "launch:state", "update:state"];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
