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
    repair: (id) => call("instance:repair", { id }),
    updateAll: (id) => call("instance:updateAll", { id }),
  },
  versions: () => call("versions:list"),
  modrinthSearch: (opts) => call("modrinth:search", opts),
  curseforgeSearch: (opts) => call("curseforge:search", opts),
  content: {
    install: (opts) => call("content:install", opts),
    installCurseforge: (opts) => call("content:installCurseforge", opts),
    list: (instanceId) => call("content:list", { instanceId }),
    remove: (opts) => call("content:remove", opts),
  },
  importModpack: (path) => call("import:mrpack", { path }),
  share: {
    code: (id) => call("share:code", { id }),
    mrpack: (id, name) => call("share:mrpack", { id, name }),
    syncFromCode: (opts) => call("share:sync", opts),
    createFromCode: (code) => call("share:create", { code }),
  },
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
  servers: {
    list: () => call("servers:list"),
    create: (opts) => call("servers:create", opts),
    start: (id) => call("servers:start", { id }),
    stop: (id) => call("servers:stop", { id }),
    command: (id, command) => call("servers:command", { id, command }),
    properties: (id) => call("servers:properties", { id }),
    setProperties: (id, patch) => call("servers:setProperties", { id, patch }),
    hosting: (id) => call("servers:hosting", { id }),
    onlineMode: (id, on) => call("servers:onlineMode", { id, on }),
    remove: (id) => call("servers:remove", { id }),
  },
  account: {
    get: () => call("account:get"),
    signOut: () => call("account:signOut"),
    start: () => call("auth:start"),
    complete: (device) => call("auth:complete", { device }),
  },
  // Lodestone cloud account — the social/sync identity (Supabase-backed).
  cloud: {
    status: () => call("cloud:status"),
    signUp: (opts) => call("cloud:signUp", opts),
    signIn: (opts) => call("cloud:signIn", opts),
    signOut: () => call("cloud:signOut"),
    profile: () => call("cloud:profile"),
    updateProfile: (patch) => call("cloud:updateProfile", patch),
    linkMinecraft: () => call("cloud:linkMinecraft"),
    searchProfiles: (query) => call("cloud:searchProfiles", { query }),
    // Friends + Presence (Vertical B). Event channels cloud:friends / cloud:presence
    // are already in the `on` allowlist below.
    friends: {
      list: () => call("cloud:friends:list"),
      search: (query) => call("cloud:friends:search", { query }),
      request: (userId) => call("cloud:friends:request", { userId }),
      respond: (id, accept) => call("cloud:friends:respond", { id, accept }),
      remove: (id) => call("cloud:friends:remove", { id }),
      block: (userId) => call("cloud:friends:block", { userId }),
      setActivity: (text) => call("cloud:friends:setActivity", { text }),
    },
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
    const allowed = ["launch:progress", "launch:log", "launch:state", "update:state", "content:log", "server:log", "server:state",
      "cloud:auth", "cloud:friends", "cloud:presence", "cloud:message", "cloud:sync"];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
