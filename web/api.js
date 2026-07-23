// Bridges the UI to the engine. In Electron it calls window.lodestone (real engine);
// in a plain browser it returns sample data so the prototype still renders.
(function () {
  const bridge = (typeof window !== "undefined" && window.lodestone && window.lodestone.isDesktop)
    ? window.lodestone : null;

  const unwrap = (r) => (r && r.ok ? r.data : (() => { throw new Error((r && r.error) || "engine error"); })());

  const sample = {
    info: { platform: "browser", arch: "—", engine: "sample-data", dataDir: "(browser)" },
    instances: [
      { id: "s1", name: "Vanilla 1.20.1", mcVersion: "1.20.1", loader: "vanilla", accent: "#5EE6A0", mods: 0, lastPlayed: Date.now() },
      { id: "s2", name: "Fabric Perf", mcVersion: "1.20.1", loader: "fabric", accent: "#B57BE6", mods: 8, lastPlayed: Date.now() - 5e6 },
    ],
    versions: { releases: ["1.20.4", "1.20.1", "1.19.2", "1.18.2", "1.16.5"], latest: "1.20.4" },
    settings: { defaultRamMB: null, javaPath: "", keepLauncherOpen: true, curseforgeKey: "" },
    servers: [
      { id: "srv1", name: "Survival SMP", platform: "paper", mcVersion: "1.20.1", ramMB: 2048, accent: "#E8E4DC", running: false, created: Date.now() - 8e6, lastStarted: Date.now() - 8e6 },
    ],
    serverProps: {
      "srv1": { motd: "Survival SMP", gamemode: "survival", difficulty: "normal", "max-players": "10", "online-mode": "true", pvp: "true" },
    },
  };

  window.API = {
    hasEngine: !!bridge,

    async info() { return bridge ? unwrap(await bridge.info()) : sample.info; },
    async instances() { return bridge ? unwrap(await bridge.instances.list()) : sample.instances.slice(); },
    async createInstance(opts) {
      if (bridge) return unwrap(await bridge.instances.create(opts));
      const i = { id: "n" + Date.now(), accent: "#5EE6A0", mods: 0, created: Date.now(), lastPlayed: null, ...opts };
      sample.instances.unshift(i); return i;
    },
    async updateInstance(opts) {
      if (bridge) return unwrap(await bridge.instances.update(opts));
      const i = sample.instances.find((x) => x.id === opts.id);
      if (i) Object.assign(i, opts);
      return i || opts;
    },
    async deleteInstance(id) {
      if (bridge) return unwrap(await bridge.instances.delete(id));
      sample.instances = sample.instances.filter((i) => i.id !== id); return true;
    },
    async versions() { return bridge ? unwrap(await bridge.versions()) : sample.versions; },
    async search(opts) {
      if (bridge) return unwrap(await bridge.modrinthSearch(opts));
      return [
        { id: "AANobbMI", title: "Sodium", author: "jellysquid3", description: "Modern rendering engine + huge FPS boost.", downloads: 12000000, icon: null, type: "mod" },
        { id: "YL57xq9U", title: "Iris Shaders", author: "coderbot", description: "Shader support on Fabric.", downloads: 8000000, icon: null, type: "mod" },
      ];
    },
    async searchCurseforge(opts) {
      if (bridge) return unwrap(await bridge.curseforgeSearch(opts));
      return [
        { id: 238222, title: "Just Enough Items (JEI)", author: "mezz", description: "View items and recipes.", downloads: 400000000, icon: null, source: "curseforge" },
        { id: 306612, title: "Fabric API", author: "modmuss50", description: "Core hooks for Fabric mods.", downloads: 300000000, icon: null, source: "curseforge" },
      ];
    },
    async importModpack() { return bridge ? unwrap(await bridge.importModpack()) : null; },

    // Power tools: repair (clear cached game files) + update all Modrinth content.
    instance: {
      async repair(id) { return bridge ? unwrap(await bridge.instances.repair(id)) : { cleared: [] }; },
      async updateAll(id) { return bridge ? unwrap(await bridge.instances.updateAll(id)) : { updated: [], upToDate: 0 }; },
    },

    async launch(id) { return bridge ? unwrap(await bridge.launch(id)) : { started: false, message: "Browser preview — launch runs in the desktop build." }; },
    async stop(id) { return bridge ? unwrap(await bridge.stop(id)) : true; },

    account: {
      async get() { return bridge ? unwrap(await bridge.account.get()) : null; },
      async signOut() { return bridge ? unwrap(await bridge.account.signOut()) : true; },
      async start() {
        return bridge ? unwrap(await bridge.account.start())
          : { userCode: "ABCD-1234", verificationUri: "https://www.microsoft.com/link", deviceCode: "demo", interval: 5, expiresIn: 900 };
      },
      async complete(device) {
        return bridge ? unwrap(await bridge.account.complete(device))
          : new Promise((res) => setTimeout(() => res({ name: "KingEstel", uuid: "37ef37c714c84044875c4546f31b64f1" }), 1500));
      },
    },

    // Lodestone cloud account (Supabase). In browser preview there's no engine,
    // so it reports "not configured" and the UI shows the setup state — never a crash.
    cloud: {
      async status() { return bridge ? unwrap(await bridge.cloud.status()) : { configured: false, signedIn: false, profile: null }; },
      async signUp(opts) {
        if (bridge) return unwrap(await bridge.cloud.signUp(opts));
        throw new Error("Cloud accounts run in the desktop app.");
      },
      async signIn(opts) {
        if (bridge) return unwrap(await bridge.cloud.signIn(opts));
        throw new Error("Cloud accounts run in the desktop app.");
      },
      async signOut() { return bridge ? unwrap(await bridge.cloud.signOut()) : true; },
      async profile() { return bridge ? unwrap(await bridge.cloud.profile()) : null; },
      async updateProfile(patch) { return bridge ? unwrap(await bridge.cloud.updateProfile(patch)) : null; },
      async linkMinecraft() { return bridge ? unwrap(await bridge.cloud.linkMinecraft()) : null; },
      async searchProfiles(query) { return bridge ? unwrap(await bridge.cloud.searchProfiles(query)) : []; },

      // [Cloud Sync — Vertical A] mirror an instance's manifest to the cloud +
      // rebuild it on another machine. Browser preview has no engine, so status
      // reports "not configured", lists are empty, and actions explain themselves.
      sync: {
        async status(instanceId) { return bridge ? unwrap(await bridge.cloud.sync.status(instanceId)) : { configured: false, signedIn: false, row: null }; },
        async list() { return bridge ? unwrap(await bridge.cloud.sync.list()) : []; },
        async push(instanceId) {
          if (bridge) return unwrap(await bridge.cloud.sync.push(instanceId));
          throw new Error("Cloud sync runs in the desktop app.");
        },
        async pull(id) {
          if (bridge) return unwrap(await bridge.cloud.sync.pull(id));
          throw new Error("Cloud sync runs in the desktop app.");
        },
        async remove(id) {
          if (bridge) return unwrap(await bridge.cloud.sync.remove(id));
          throw new Error("Cloud sync runs in the desktop app.");
        },
      },
      // Friends + Presence (Vertical B). Browser preview has no engine, so reads
      // return empty shapes and mutations explain they need the desktop app.
      friends: {
        async list() { return bridge ? unwrap(await bridge.cloud.friends.list()) : { friends: [], incoming: [], outgoing: [], blocked: [] }; },
        async search(query) { return bridge ? unwrap(await bridge.cloud.friends.search(query)) : []; },
        async request(userId) {
          if (bridge) return unwrap(await bridge.cloud.friends.request(userId));
          throw new Error("Friends run in the desktop app.");
        },
        async respond(id, accept) {
          if (bridge) return unwrap(await bridge.cloud.friends.respond(id, accept));
          throw new Error("Friends run in the desktop app.");
        },
        async remove(id) { return bridge ? unwrap(await bridge.cloud.friends.remove(id)) : true; },
        async block(userId) {
          if (bridge) return unwrap(await bridge.cloud.friends.block(userId));
          throw new Error("Friends run in the desktop app.");
        },
        async setActivity(text) { return bridge ? unwrap(await bridge.cloud.friends.setActivity(text)) : true; },
      },
      // Chat + Squads (Vertical C). Reads fail soft to empty in browser preview;
      // mutations explain that squads/chat run in the desktop app — never a crash.
      chat: {
        async listSquads() { return bridge ? unwrap(await bridge.cloud.chat.listSquads()) : []; },
        async createSquad(opts) {
          if (bridge) return unwrap(await bridge.cloud.chat.createSquad(opts));
          throw new Error("Squads run in the desktop app.");
        },
        async joinSquad(opts) {
          if (bridge) return unwrap(await bridge.cloud.chat.joinSquad(opts));
          throw new Error("Squads run in the desktop app.");
        },
        async leaveSquad(squadId) { return bridge ? unwrap(await bridge.cloud.chat.leaveSquad(squadId)) : true; },
        async squadInvite(squadId) {
          if (bridge) return unwrap(await bridge.cloud.chat.squadInvite(squadId));
          throw new Error("Squads run in the desktop app.");
        },
        async startDm(userId) {
          if (bridge) return unwrap(await bridge.cloud.chat.startDm(userId));
          throw new Error("Chat runs in the desktop app.");
        },
        async listDMs() { return bridge ? unwrap(await bridge.cloud.chat.listDMs()) : []; },
        async history(opts) { return bridge ? unwrap(await bridge.cloud.chat.history(opts)) : []; },
        async send(opts) {
          if (bridge) return unwrap(await bridge.cloud.chat.send(opts));
          throw new Error("Chat runs in the desktop app.");
        },
      },
    },

    on(channel, fn) { return bridge ? bridge.on(channel, fn) : () => {}; },
    openExternal(url) { if (bridge) bridge.openExternal(url); else window.open(url, "_blank"); },
    openDataDir() { if (bridge) bridge.openDataDir(); },

    update: {
      check() { if (bridge) bridge.update.check(); },
      install() { if (bridge) bridge.update.install(); },
    },

    settings: {
      async get() { return bridge ? unwrap(await bridge.settings.get()) : { ...sample.settings }; },
      async set(patch) {
        if (bridge) return unwrap(await bridge.settings.set(patch));
        Object.assign(sample.settings, patch); return { ...sample.settings };
      },
    },

    content: {
      async install(opts) {
        if (bridge) return unwrap(await bridge.content.install(opts));
        return { installed: [{ projectId: opts.projectId, title: "Sample mod", kind: "mod", fileName: "sample.jar" }], content: [] };
      },
      async installCurseforge(opts) {
        if (bridge) return unwrap(await bridge.content.installCurseforge(opts));
        return { installed: [{ projectId: "cf:" + opts.modId, title: "Sample CurseForge mod", kind: "mod", fileName: "sample.jar", source: "curseforge" }], content: [] };
      },
      async list(instanceId) { return bridge ? unwrap(await bridge.content.list(instanceId)) : []; },
      async remove(opts) { return bridge ? unwrap(await bridge.content.remove(opts)) : true; },
    },

    // Share & sync: a share code / .mrpack moves a pack between machines; "Sync now"
    // reconciles an instance's mods to a pasted code. Browser preview returns stand-ins.
    share: {
      async code(id) {
        if (bridge) return unwrap(await bridge.share.code(id));
        const i = sample.instances.find((x) => x.id === id) || { name: "Sample", loader: "fabric", mcVersion: "1.20.1" };
        const def = { name: i.name, loader: i.loader, mcVersion: i.mcVersion, mods: [] };
        return btoa(JSON.stringify(def)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      },
      async mrpack(id, name) { return bridge ? unwrap(await bridge.share.mrpack(id, name)) : null; },
      async syncFromCode(opts) {
        if (bridge) return unwrap(await bridge.share.syncFromCode(opts));
        return { instance: null, added: 0, removed: 0, unchanged: 0 };
      },
      async createFromCode(code) {
        if (bridge) return unwrap(await bridge.share.createFromCode(code));
        const i = { id: "n" + Date.now(), name: "Shared pack", mcVersion: "1.20.1", loader: "fabric", accent: "#B57BE6", mods: 0, created: Date.now(), lastPlayed: null };
        sample.instances.unshift(i);
        return { instance: i, added: 0, removed: 0, unchanged: 0 };
      },
    },

    worlds: {
      async list(instanceId) { return bridge ? unwrap(await bridge.worlds.list(instanceId)) : []; },
      async backups(instanceId) { return bridge ? unwrap(await bridge.worlds.backups(instanceId)) : []; },
      async backup(opts) { return bridge ? unwrap(await bridge.worlds.backup(opts)) : true; },
      async restore(opts) { return bridge ? unwrap(await bridge.worlds.restore(opts)) : true; },
      async rename(opts) { return bridge ? unwrap(await bridge.worlds.rename(opts)) : true; },
      async remove(opts) { return bridge ? unwrap(await bridge.worlds.remove(opts)) : true; },
    },

    servers: {
      async list() { return bridge ? unwrap(await bridge.servers.list()) : sample.servers.slice(); },
      async create(opts) {
        if (bridge) return unwrap(await bridge.servers.create(opts));
        const s = { id: "srv" + Date.now(), name: (opts.name && opts.name.trim()) || `${opts.platform} ${opts.mcVersion}`,
          platform: opts.platform, mcVersion: opts.mcVersion, ramMB: 2048, accent: "#5EE6A0",
          running: false, created: Date.now(), lastStarted: null };
        sample.servers.unshift(s);
        sample.serverProps[s.id] = { motd: s.name, gamemode: "survival", difficulty: "easy", "max-players": "20", "online-mode": "true", pvp: "true" };
        return s;
      },
      async start(id) {
        if (bridge) return unwrap(await bridge.servers.start(id));
        const s = sample.servers.find((x) => x.id === id); if (s) s.running = true;
        return { started: true };
      },
      async stop(id) {
        if (bridge) return unwrap(await bridge.servers.stop(id));
        const s = sample.servers.find((x) => x.id === id); if (s) s.running = false;
        return true;
      },
      async command(id, command) { return bridge ? unwrap(await bridge.servers.command(id, command)) : true; },
      async properties(id) { return bridge ? unwrap(await bridge.servers.properties(id)) : { ...(sample.serverProps[id] || {}) }; },
      async setProperties(id, patch) {
        if (bridge) return unwrap(await bridge.servers.setProperties(id, patch));
        sample.serverProps[id] = { ...(sample.serverProps[id] || {}), ...patch }; return { ...sample.serverProps[id] };
      },
      async hosting(id) {
        if (bridge) return unwrap(await bridge.servers.hosting(id));
        const props = sample.serverProps[id] || {};
        const portNum = Number(props["server-port"]);
        const port = Number.isFinite(portNum) && portNum > 0 ? Math.round(portNum) : 25565;
        return { port, lan: [`192.168.1.42:${port}`], tailscale: null,
          onlineMode: props["online-mode"] != null ? String(props["online-mode"]) : "true" };
      },
      async setOnlineMode(id, on) {
        if (bridge) return unwrap(await bridge.servers.onlineMode(id, on));
        const value = on ? "true" : "false";
        sample.serverProps[id] = { ...(sample.serverProps[id] || {}), "online-mode": value };
        return value;
      },
      async remove(id) {
        if (bridge) return unwrap(await bridge.servers.remove(id));
        sample.servers = sample.servers.filter((x) => x.id !== id); delete sample.serverProps[id]; return true;
      },
    },
  };
})();

// ======================================================================
// [Crash Doctor] — crash scan + fixes + the persistent mod bisect.
// Browser preview: reads fail soft to empty shapes; mutations explain that
// the doctor runs in the desktop app — never a crash.
// ======================================================================
(function () {
  const bridge = (typeof window !== "undefined" && window.lodestone && window.lodestone.isDesktop)
    ? window.lodestone : null;
  const unwrap = (r) => (r && r.ok ? r.data : (() => { throw new Error((r && r.error) || "engine error"); })());

  window.API.doctor = {
    async scan(instanceId) {
      if (bridge) return unwrap(await bridge.doctor.scan(instanceId));
      return { crashReport: null, latestLog: null, description: null, exception: null, diagnoses: [], enabledMods: 0, disabledMods: 0 };
    },
    async fix(instanceId, fix) {
      if (bridge) return unwrap(await bridge.doctor.fix(instanceId, fix));
      throw new Error("Crash Doctor runs in the desktop app.");
    },
    bisect: {
      async status(instanceId) { return bridge ? unwrap(await bridge.doctor.bisectStatus(instanceId)) : { active: false, status: "none" }; },
      async start(instanceId) {
        if (bridge) return unwrap(await bridge.doctor.bisectStart(instanceId));
        throw new Error("Crash Doctor runs in the desktop app.");
      },
      async report(instanceId, crashed) {
        if (bridge) return unwrap(await bridge.doctor.bisectReport(instanceId, crashed));
        throw new Error("Crash Doctor runs in the desktop app.");
      },
      async abort(instanceId, restore) { return bridge ? unwrap(await bridge.doctor.bisectAbort(instanceId, restore)) : { cleared: true, restored: false }; },
    },
  };
})();

// ============================================================================
// [Content managers vertical] API.packs + API.keybinds — resource packs /
// shaders / datapacks + the keybinds manager. A separate IIFE appended after
// the core API so the shared block above stays untouched (union-merge safe).
// In a plain browser, reads return empty desktop-shaped data and mutations
// explain they need the desktop app — never a crash.
// ============================================================================
(function () {
  const bridge = (typeof window !== "undefined" && window.lodestone && window.lodestone.isDesktop)
    ? window.lodestone : null;
  const unwrap = (r) => (r && r.ok ? r.data : (() => { throw new Error((r && r.error) || "engine error"); })());
  const desktopOnly = (what) => { throw new Error(`${what} run in the desktop app.`); };

  window.API.packs = {
    async resourcePacks(instanceId) {
      return bridge ? unwrap(await bridge.packs.resourcePacks(instanceId)) : { hasOptions: false, packs: [], enabledOrder: [] };
    },
    async setResourcePack(opts) {
      if (bridge) return unwrap(await bridge.packs.setResourcePack(opts));
      desktopOnly("Pack managers");
    },
    async reorderResourcePacks(opts) {
      if (bridge) return unwrap(await bridge.packs.reorderResourcePacks(opts));
      desktopOnly("Pack managers");
    },
    async shaders(instanceId) {
      return bridge ? unwrap(await bridge.packs.shaders(instanceId)) : { packs: [], configFile: null, canSelect: false, selected: null, shadersOn: false };
    },
    async selectShader(opts) {
      if (bridge) return unwrap(await bridge.packs.selectShader(opts));
      desktopOnly("Pack managers");
    },
    async datapacks(opts) {
      return bridge ? unwrap(await bridge.packs.datapacks(opts)) : { packs: [] };
    },
    async delete(opts) {
      if (bridge) return unwrap(await bridge.packs.delete(opts));
      desktopOnly("Pack managers");
    },
    async import(opts) {
      if (bridge) return unwrap(await bridge.packs.import(opts));
      desktopOnly("Pack managers");
    },
    async openFolder(opts) {
      if (bridge) return unwrap(await bridge.packs.openFolder(opts));
      desktopOnly("Pack managers");
    },
  };

  window.API.keybinds = {
    async list(instanceId) {
      return bridge ? unwrap(await bridge.keybinds.list(instanceId)) : { hasOptions: false, binds: [], categories: [] };
    },
    async set(opts) {
      if (bridge) return unwrap(await bridge.keybinds.set(opts));
      desktopOnly("Keybinds");
    },
    async reset(opts) {
      if (bridge) return unwrap(await bridge.keybinds.reset(opts));
      desktopOnly("Keybinds");
    },
    async resetAll(instanceId) {
      if (bridge) return unwrap(await bridge.keybinds.resetAll(instanceId));
      desktopOnly("Keybinds");
    },
  };
})();

// ============================================================================
// [Icons + .lodepack — vertical feat/win-icons-lodepack] — additive section.
// Augments window.API with unified pack import (.mrpack / .zip / .lodepack),
// .lodepack export, and per-instance icons over the window.lodestonePacks bridge.
// In a plain browser these explain themselves instead of crashing (same policy
// as everything above).
(function () {
  const packs = (typeof window !== "undefined" && window.lodestonePacks) ? window.lodestonePacks : null;
  const unwrap = (r) => (r && r.ok ? r.data : (() => { throw new Error((r && r.error) || "engine error"); })());

  window.API.lodepack = {
    async import(path) {
      if (packs) return unwrap(await packs.importPack(path));
      throw new Error("Pack import runs in the desktop build.");
    },
    async exportLodepack(id, name) {
      if (packs) return unwrap(await packs.exportLodepack(id, name));
      throw new Error("Pack export runs in the desktop build.");
    },
    pathForFile(file) { return packs ? packs.pathForFile(file) : null; },
  };

  window.API.icons = {
    async pick(id) {
      if (packs) return unwrap(await packs.iconPick(id));
      throw new Error("Instance icons run in the desktop build.");
    },
    async set(id, dataBase64, ext) {
      if (packs) return unwrap(await packs.iconSet(id, dataBase64, ext));
      throw new Error("Instance icons run in the desktop build.");
    },
    async remove(id) {
      if (packs) return unwrap(await packs.iconRemove(id));
      throw new Error("Instance icons run in the desktop build.");
    },
  };
})();
// ============================================================================
