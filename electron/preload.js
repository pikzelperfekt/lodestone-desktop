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
  versions: (opts) => call("versions:list", opts), // [wave0] opts.channels → snapshots/old versions
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
    create: (opts) => call("worlds:create", opts),
    scanMixins: (instanceId) => call("mixins:scan", { instanceId }),
    seedAvailable: () => call("seed:available"),
    seedSearch: (opts) => call("seed:search", opts),
    import: (opts) => call("worlds:import", opts),
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
    // [Cloud Sync — Vertical A] push/pull an instance's manifest to synced_instances.
    sync: {
      push: (instanceId) => call("cloud:sync:push", { instanceId }),
      list: () => call("cloud:sync:list"),
      pull: (id) => call("cloud:sync:pull", { id }),
      remove: (id) => call("cloud:sync:remove", { id }),
      status: (instanceId) => call("cloud:sync:status", { instanceId }),
    },
    // Shared packs: a permanent code, and edits that propagate live.
    // Named sharedPacks, NOT packs — the top-level `packs` bridge below is the
    // resource-pack / shader / datapack manager and means something else.
    sharedPacks: {
      share: (instanceId, mode) => call("pack:share", { instanceId, mode }),
      join: (code) => call("pack:join", { code }),
      publish: (instanceId) => call("pack:publish", { instanceId }),
      list: () => call("pack:list"),
      status: (instanceId) => call("pack:status", { instanceId }),
      setMode: (packId, mode) => call("pack:setMode", { packId, mode }),
      invite: (packId, memberId) => call("pack:invite", { packId, memberId }),
      members: (packId) => call("pack:members", { packId }),
      leave: (packId) => call("pack:leave", { packId }),
    },
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
    // Chat + Squads (Vertical C) — live delivery arrives on the "cloud:message" event.
    chat: {
      createSquad: (opts) => call("cloud:createSquad", opts),
      joinSquad: (opts) => call("cloud:joinSquad", opts),
      leaveSquad: (squadId) => call("cloud:leaveSquad", { squadId }),
      listSquads: () => call("cloud:listSquads"),
      squadInvite: (squadId) => call("cloud:squadInvite", { squadId }),
      startDm: (userId) => call("cloud:startDm", { userId }),
      listDMs: () => call("cloud:listDMs"),
      history: (opts) => call("cloud:chatHistory", opts),
      send: (opts) => call("cloud:chatSend", opts),
    },
  },
  // [Crash Doctor] crash scan + fixes + the persistent mod bisect.
  doctor: {
    scan: (instanceId) => call("doctor:scan", { instanceId }),
    fix: (instanceId, fix) => call("doctor:fix", { instanceId, fix }),
    bisectStatus: (instanceId) => call("doctor:bisect:status", { instanceId }),
    bisectStart: (instanceId) => call("doctor:bisect:start", { instanceId }),
    bisectReport: (instanceId, crashed) => call("doctor:bisect:report", { instanceId, crashed }),
    bisectAbort: (instanceId, restore) => call("doctor:bisect:abort", { instanceId, restore }),
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
      "cloud:auth", "cloud:friends", "cloud:presence", "cloud:message", "cloud:sync",
      "pack:shared", "pack:joined", "pack:published", "pack:applied", "pack:left", "pack:error",
      "seed:progress"];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  // ==========================================================================
  // [Content managers vertical] resource packs / shaders / datapacks + keybinds.
  // ==========================================================================
  packs: {
    resourcePacks: (instanceId) => call("packs:resourcepacks", { instanceId }),
    setResourcePack: (opts) => call("packs:resourcepacks:set", opts),
    reorderResourcePacks: (opts) => call("packs:resourcepacks:reorder", opts),
    shaders: (instanceId) => call("packs:shaders", { instanceId }),
    selectShader: (opts) => call("packs:shaders:select", opts),
    datapacks: (opts) => call("packs:datapacks", opts),
    delete: (opts) => call("packs:delete", opts),
    import: (opts) => call("packs:import", opts),
    openFolder: (opts) => call("packs:openFolder", opts),
  },
  // Global SETUP profiles (distinct from the per-instance keybinds below).
  setup: {
    gameGet: () => call("setup:game:get"),
    gameSet: (patch) => call("setup:game:set", patch),
    keybindsGet: () => call("setup:keybinds:get"),
    keybindsSet: (opts) => call("setup:keybinds:set", opts),
    keybindsReset: () => call("setup:keybinds:reset"),
    skinProfile: () => call("setup:skin:profile"),
    skinUpload: (dataBase64, variant) => call("setup:skin:upload", { dataBase64, variant }),
    skinReset: () => call("setup:skin:reset"),
  },
  keybinds: {
    list: (instanceId) => call("keybinds:list", { instanceId }),
    set: (opts) => call("keybinds:set", opts),
    reset: (opts) => call("keybinds:reset", opts),
    resetAll: (instanceId) => call("keybinds:resetAll", { instanceId }),
  },
});

// ============================================================================
// [Icons + .lodepack — vertical feat/win-icons-lodepack] — additive section.
// A second, self-contained bridge (window.lodestonePacks) so this vertical never
// edits the main allowlist above: unified pack import, .lodepack export, and
// per-instance icons.
let webUtils = null;
try { ({ webUtils } = require("electron")); } catch {}

contextBridge.exposeInMainWorld("lodestonePacks", {
  importPack: (path) => call("import:pack", { path }),
  exportLodepack: (id, name) => call("share:lodepack", { id, name }),
  iconPick: (id) => call("icon:pick", { id }),
  iconSet: (id, dataBase64, ext) => call("icon:set", { id, dataBase64, ext }),
  iconRemove: (id) => call("icon:remove", { id }),
  // Electron ≥32 removed File.path — resolve a dragged file's real path either way.
  pathForFile: (file) => {
    try { if (webUtils && webUtils.getPathForFile) return webUtils.getPathForFile(file); } catch {}
    return (file && file.path) || null;
  },
});
// ============================================================================
