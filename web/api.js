// Bridges the UI to the engine. In Electron it calls window.lodestone (real engine);
// in a plain browser it returns sample data so the prototype still renders.
(function () {
  const bridge = (typeof window !== "undefined" && window.lodestone && window.lodestone.isDesktop)
    ? window.lodestone : null;

  const unwrap = (r) => (r && r.ok ? r.data : (() => { throw new Error((r && r.error) || "engine error"); })());

  const sample = {
    info: { platform: "browser", arch: "—", engine: "sample-data", dataDir: "(browser)" },
    instances: [
      { id: "s1", name: "NeoForge", mcVersion: "1.21.1", loader: "neoforge", accent: "#E08A3C", mods: 176, pinned: true, playtimeMs: 31_920_000, lastPlayed: Date.now() - 15 * 60_000 },
      { id: "s2", name: "Vanilla Beans", mcVersion: "1.21.1", loader: "fabric", accent: "#E6467A", mods: 24, pinned: true, playtimeMs: 12_600_000, lastPlayed: Date.now() - 8 * 3600_000 },
      { id: "s3", name: "Vanilla", mcVersion: "1.20.1", loader: "vanilla", accent: "#9B7BE6", mods: 0, playtimeMs: 16_000, lastPlayed: Date.now() - 2 * 86400_000 },
      { id: "s4", name: "All The Mods 9", mcVersion: "1.21.1", loader: "neoforge", accent: "#5FC9C0", mods: 412, playtimeMs: 268_000_000, lastPlayed: Date.now() - 3 * 86400_000 },
      { id: "s5", name: "SkyFactory", mcVersion: "1.20.1", loader: "forge", accent: "#E0B34A", mods: 210, playtimeMs: 900_000_000, lastPlayed: Date.now() - 9 * 86400_000 },
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
    async versions(opts) { return bridge ? unwrap(await bridge.versions(opts)) : sample.versions; }, // [wave0] opts.channels
    async project(opts) {
      if (bridge) return unwrap(await bridge.modrinthProject(opts));
      throw new Error("Project details run in the desktop app.");
    },
    async curseforgeProject(opts) {
      if (bridge) return unwrap(await bridge.curseforgeProject(opts));
      throw new Error("Project details run in the desktop app.");
    },
    async search(opts) {
      if (bridge) return unwrap(await bridge.modrinthSearch(opts));
      return { total: 2, offset: 0, categories: ["optimization", "utility"], hits: [
        { id: "AANobbMI", title: "Sodium", author: "jellysquid3", description: "Modern rendering engine + huge FPS boost.", downloads: 12000000, icon: null, type: "mod", categories: ["optimization"] },
        { id: "YL57xq9U", title: "Iris Shaders", author: "coderbot", description: "Shader support on Fabric.", downloads: 8000000, icon: null, type: "mod", categories: ["optimization"] },
      ] };
    },
    async searchCurseforge(opts) {
      if (bridge) return unwrap(await bridge.curseforgeSearch(opts));
      return [
        { id: 238222, title: "Just Enough Items (JEI)", author: "mezz", description: "View items and recipes.", downloads: 400000000, icon: null, source: "curseforge" },
        { id: 306612, title: "Fabric API", author: "modmuss50", description: "Core hooks for Fabric mods.", downloads: 300000000, icon: null, source: "curseforge" },
      ];
    },
    async importModpack() { return bridge ? unwrap(await bridge.importModpack()) : null; },
    async publishInstance(instanceId, summary) {
      if (!bridge) throw new Error("Publishing needs the desktop app.");
      return unwrap(await bridge.publishInstance(instanceId, summary));
    },

    // Power tools: repair (clear cached game files) + update all Modrinth content.
    async listMods(instanceId) {
      if (!bridge) return { mods: [], total: 0, enabled: 0 };
      try { return unwrap(await bridge.instances.mods(instanceId)); } catch { return { mods: [], total: 0, enabled: 0 }; }
    },
    async toggleMod(opts) {
      if (bridge) return unwrap(await bridge.instances.toggleMod(opts));
      throw new Error("Toggling mods runs in the desktop app.");
    },
    async storage() {
      if (!bridge) return { buckets: [], perInstance: [], total: 0 };
      try { return unwrap(await bridge.instances.storage()); } catch { return { buckets: [], perInstance: [], total: 0 }; }
    },
    async reclaim(bucket) {
      if (bridge) return unwrap(await bridge.instances.reclaim(bucket));
      throw new Error("Storage tools run in the desktop app.");
    },
    async browse(opts) {
      if (!bridge) return { rel: "", entries: [] };
      try { return unwrap(await bridge.instances.browse(opts)); } catch { return { rel: "", entries: [] }; }
    },
    async readFile(opts) {
      if (bridge) return unwrap(await bridge.instances.readFile(opts));
      throw new Error("Editing files runs in the desktop app.");
    },
    async writeFile(opts) {
      if (bridge) return unwrap(await bridge.instances.writeFile(opts));
      throw new Error("Editing files runs in the desktop app.");
    },
    async configs(instanceId) {
      if (!bridge) return { root: "", configs: [] };
      try { return unwrap(await bridge.instances.configs(instanceId)); } catch { return { root: "", configs: [] }; }
    },
    async lanStart() { if (!bridge) return { listening: false }; try { return unwrap(await bridge.instances.lanStart()); } catch { return { listening: false }; } },
    async lanStop() { if (!bridge) return { listening: false }; try { return unwrap(await bridge.instances.lanStop()); } catch { return { listening: false }; } },
    async lanList() {
      if (!bridge) return { listening: false, worlds: [] };
      try { return unwrap(await bridge.instances.lanList()); } catch { return { listening: false, worlds: [] }; }
    },
    async notes(instanceId) {
      if (!bridge) return { note: "", links: [] };
      try { return unwrap(await bridge.instances.notes(instanceId)); } catch { return { note: "", links: [] }; }
    },
    async setNotes(opts) {
      if (bridge) return unwrap(await bridge.instances.setNotes(opts));
      throw new Error("Notes run in the desktop app.");
    },
    async notifications() {
      if (!bridge) return [];
      try { return unwrap(await bridge.instances.notifications()); } catch { return []; }
    },
    async dismissNotification(id) {
      if (!bridge) return []; try { return unwrap(await bridge.instances.dismissNotification(id)); } catch { return []; }
    },
    async clearNotifications() {
      if (!bridge) return []; try { return unwrap(await bridge.instances.clearNotifications()); } catch { return []; }
    },
    async sessions(opts) {
      if (!bridge) return [];
      try { return unwrap(await bridge.instances.sessions(opts)); } catch { return []; }
    },
    async heatmap(opts) {
      if (!bridge) return { byDay: {}, max: 0, days: 365 };
      try { return unwrap(await bridge.instances.heatmap(opts)); } catch { return { byDay: {}, max: 0, days: 365 }; }
    },
    async wrapped(opts) {
      if (!bridge) return { hasData: false, top: [] };
      try { return unwrap(await bridge.instances.wrapped(opts)); } catch { return { hasData: false, top: [] }; }
    },
    async achievements() {
      if (!bridge) return { achievements: [], unlocked: 0, total: 0 };
      try { return unwrap(await bridge.instances.achievements()); } catch { return { achievements: [], unlocked: 0, total: 0 }; }
    },
    async reorderInstances(order) {
      if (bridge) return unwrap(await bridge.instances.reorder(order));
      throw new Error("Reordering runs in the desktop app.");
    },
    async groups() {
      if (!bridge) return [];
      try { return unwrap(await bridge.instances.groups()); } catch { return []; }
    },
    async saveGroup(opts) {
      if (bridge) return unwrap(await bridge.instances.saveGroup(opts));
      throw new Error("Groups run in the desktop app.");
    },
    async deleteGroup(id) {
      if (bridge) return unwrap(await bridge.instances.deleteGroup(id));
      throw new Error("Groups run in the desktop app.");
    },
    async assignGroup(opts) {
      if (bridge) return unwrap(await bridge.instances.assignGroup(opts));
      throw new Error("Groups run in the desktop app.");
    },
    async screenshots(instanceId) {
      if (!bridge) return { shots: [], dir: "" };
      try { return unwrap(await bridge.instances.screenshots(instanceId)); } catch { return { shots: [], dir: "" }; }
    },
    async instanceLog(instanceId) {
      if (!bridge) return { lines: [], exists: false, dir: "" };
      try { return unwrap(await bridge.instances.log(instanceId)); } catch { return { lines: [], exists: false, dir: "" }; }
    },
    async loaderBridge(instanceId) {
      if (!bridge) return { connector: false };
      try { return unwrap(await bridge.instances.loaderBridge(instanceId)); } catch { return { connector: false }; }
    },
    async instanceSizes() {
      if (!bridge) return { sizes: {}, total: 0 };
      try { return unwrap(await bridge.instances.sizes()); } catch { return { sizes: {}, total: 0 }; }
    },
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
      // Shared packs — one permanent code, edits propagate live to members.
      // Reads fail soft (empty / not-shared) so the UI renders fine offline;
      // actions throw one clean line.
      sharedPacks: {
        async status(instanceId) {
          if (!bridge) return { shared: false };
          try { return unwrap(await bridge.cloud.sharedPacks.status(instanceId)); } catch { return { shared: false }; }
        },
        async list() {
          if (!bridge) return [];
          try { return unwrap(await bridge.cloud.sharedPacks.list()); } catch { return []; }
        },
        async members(packId) {
          if (!bridge) return [];
          try { return unwrap(await bridge.cloud.sharedPacks.members(packId)); } catch { return []; }
        },
        async share(instanceId, mode) {
          if (bridge) return unwrap(await bridge.cloud.sharedPacks.share(instanceId, mode));
          throw new Error("Sharing runs in the desktop app.");
        },
        async join(code) {
          if (bridge) return unwrap(await bridge.cloud.sharedPacks.join(code));
          throw new Error("Sharing runs in the desktop app.");
        },
        async publish(instanceId) {
          if (bridge) return unwrap(await bridge.cloud.sharedPacks.publish(instanceId));
          throw new Error("Sharing runs in the desktop app.");
        },
        async setMode(packId, mode) {
          if (bridge) return unwrap(await bridge.cloud.sharedPacks.setMode(packId, mode));
          throw new Error("Sharing runs in the desktop app.");
        },
        async invite(packId, memberId) {
          if (bridge) return unwrap(await bridge.cloud.sharedPacks.invite(packId, memberId));
          throw new Error("Sharing runs in the desktop app.");
        },
        async leave(packId) {
          if (bridge) return unwrap(await bridge.cloud.sharedPacks.leave(packId));
          throw new Error("Sharing runs in the desktop app.");
        },
      },
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

    // Global SETUP profiles: Game settings, Keybinds, Skins.
    worldTools: {
      async seedAvailable() {
        if (!bridge) return false;
        try { return unwrap(await bridge.worlds.seedAvailable()); } catch { return false; }
      },
      async seedSearch(opts) {
        if (bridge) return unwrap(await bridge.worlds.seedSearch(opts));
        throw new Error("Seed search runs in the desktop app.");
      },
      async seedMap(opts) {
        if (bridge) return unwrap(await bridge.worlds.seedMap(opts));
        throw new Error("Seed maps run in the desktop app.");
      },
      async foreverCreate(opts) {
        if (bridge) return unwrap(await bridge.worlds.foreverCreate(opts));
        throw new Error("Forever Worlds run in the desktop app.");
      },
      async foreverList() { if (!bridge) return []; try { return unwrap(await bridge.worlds.foreverList()); } catch { return []; } },
      async foreverEnter(id) {
        if (bridge) return unwrap(await bridge.worlds.foreverEnter(id));
        throw new Error("Forever Worlds run in the desktop app.");
      },
      async foreverDelete(id) {
        if (bridge) return unwrap(await bridge.worlds.foreverDelete(id));
        throw new Error("Forever Worlds run in the desktop app.");
      },
      async pregenStart(opts) {
        if (bridge) return unwrap(await bridge.worlds.pregenStart(opts));
        throw new Error("Pregeneration runs in the desktop app.");
      },
      async pregenStop() { if (!bridge) return { running: false }; try { return unwrap(await bridge.worlds.pregenStop()); } catch { return { running: false }; } },
      async pregenStatus() { if (!bridge) return { running: false }; try { return unwrap(await bridge.worlds.pregenStatus()); } catch { return { running: false }; } },
      async pregenResult() { if (!bridge) return null; try { return unwrap(await bridge.worlds.pregenResult()); } catch { return null; } },
      async cfAudit(instanceId) {
        if (!bridge) return { tracked: [], orphans: [], hasKey: false };
        try { return unwrap(await bridge.worlds.cfAudit(instanceId)); } catch { return { tracked: [], orphans: [], hasKey: false }; }
      },
      async backupSettings() {
        if (!bridge) return { enabled: false, everyHours: 12, keep: 5, lastRun: 0 };
        try { return unwrap(await bridge.worlds.backupSettings()); } catch { return { enabled: false, everyHours: 12, keep: 5, lastRun: 0 }; }
      },
      async setBackupSettings(opts) {
        if (bridge) return unwrap(await bridge.worlds.setBackupSettings(opts));
        throw new Error("Backups run in the desktop app.");
      },
      async runBackupsNow() {
        if (bridge) return unwrap(await bridge.worlds.runBackupsNow());
        throw new Error("Backups run in the desktop app.");
      },
      async health(instanceId) {
        if (!bridge) return { ok: true, findings: [], mods: 0, disabled: 0, size: 0, ramMB: null };
        try { return unwrap(await bridge.worlds.health(instanceId)); } catch { return { ok: true, findings: [], mods: 0, disabled: 0, size: 0, ramMB: null }; }
      },
      async scanMixins(instanceId) {
        if (bridge) return unwrap(await bridge.worlds.scanMixins(instanceId));
        throw new Error("Mixin scanning runs in the desktop app.");
      },
      async create(opts) {
        if (bridge) return unwrap(await bridge.worlds.create(opts));
        throw new Error("World creation runs in the desktop app.");
      },
      async info(opts) {
        if (bridge) return unwrap(await bridge.worlds.info(opts));
        throw new Error("World details run in the desktop app.");
      },
      async scan(opts) {
        if (!bridge) return { chunks: 0, biomes: [], cells: [], regionsScanned: 0 };
        try { return unwrap(await bridge.worlds.scan(opts)); } catch { return { chunks: 0, biomes: [], cells: [], regionsScanned: 0 }; }
      },
      async import(opts) {
        if (bridge) return unwrap(await bridge.worlds.import(opts));
        throw new Error("World import runs in the desktop app.");
      },
    },
    setup: {
      async game() {
        if (!bridge) return { fields: [], values: {}, applyOnLaunch: true };
        try { return unwrap(await bridge.setup.gameGet()); } catch { return { fields: [], values: {}, applyOnLaunch: true }; }
      },
      async setApplyOnLaunch(on) {
        if (bridge) return unwrap(await bridge.setup.gameApply(on));
        throw new Error("Game settings run in the desktop app.");
      },
      async setGame(patch) {
        if (bridge) return unwrap(await bridge.setup.gameSet(patch));
        throw new Error("Game settings run in the desktop app.");
      },
      async keybinds() {
        const empty = { rows: [], conflicts: [], presets: [], activeId: null, applyOnLaunch: true, discoveredCount: 0, disabledCount: 0 };
        if (!bridge) return empty;
        try { return unwrap(await bridge.setup.keybindsGet()); } catch { return empty; }
      },
      async setKeybindDisabled(opts) {
        if (bridge) return unwrap(await bridge.setup.keybindsDisabled(opts));
        throw new Error("Keybinds run in the desktop app.");
      },
      async setKeybindApply(on) {
        if (bridge) return unwrap(await bridge.setup.keybindsApply(on));
        throw new Error("Keybinds run in the desktop app.");
      },
      async keybindPreset(opts) {
        if (bridge) return unwrap(await bridge.setup.keybindsPreset(opts));
        throw new Error("Keybinds run in the desktop app.");
      },
      async refreshKeybinds() {
        if (bridge) return unwrap(await bridge.setup.keybindsRefresh());
        throw new Error("Keybinds run in the desktop app.");
      },
      async setKeybind(opts) {
        if (bridge) return unwrap(await bridge.setup.keybindsSet(opts));
        throw new Error("Keybinds run in the desktop app.");
      },
      async resetKeybinds() {
        if (bridge) return unwrap(await bridge.setup.keybindsReset());
        throw new Error("Keybinds run in the desktop app.");
      },
      async skinProfile() {
        if (bridge) return unwrap(await bridge.setup.skinProfile());
        throw new Error("Skins run in the desktop app.");
      },
      async skinUpload(dataBase64, variant) {
        if (bridge) return unwrap(await bridge.setup.skinUpload(dataBase64, variant));
        throw new Error("Skins run in the desktop app.");
      },
      async skinList() { if (!bridge) return []; try { return unwrap(await bridge.setup.skinList()); } catch { return []; } },
      async skinSave(opts) {
        if (bridge) return unwrap(await bridge.setup.skinSave(opts));
        throw new Error("Skins run in the desktop app.");
      },
      async skinRemove(id) {
        if (bridge) return unwrap(await bridge.setup.skinRemove(id));
        throw new Error("Skins run in the desktop app.");
      },
      async skinRename(opts) {
        if (bridge) return unwrap(await bridge.setup.skinRename(opts));
        throw new Error("Skins run in the desktop app.");
      },
      async skinApply(id) {
        if (bridge) return unwrap(await bridge.setup.skinApply(id));
        throw new Error("Skins run in the desktop app.");
      },
      async skinReset() {
        if (bridge) return unwrap(await bridge.setup.skinReset());
        throw new Error("Skins run in the desktop app.");
      },
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
      async stats(id) {
        const idle = { running: false, ready: false, players: [], playerCount: 0, maxPlayers: null, tps: null, uptimeMs: 0, ramMB: null };
        if (!bridge) return idle;
        try { return unwrap(await bridge.servers.stats(id)); } catch { return idle; }
      },
      async access(id) {
        if (!bridge) return { whitelist: [], ops: [], banned: [], whitelistEnforced: false };
        try { return unwrap(await bridge.servers.access(id)); } catch { return { whitelist: [], ops: [], banned: [], whitelistEnforced: false }; }
      },
      async accessChange(opts) {
        if (bridge) return unwrap(await bridge.servers.accessChange(opts));
        throw new Error("Server access runs in the desktop app.");
      },
      async plugins(id) {
        if (!bridge) return { supported: false, plugins: [] };
        try { return unwrap(await bridge.servers.plugins(id)); } catch { return { supported: false, plugins: [] }; }
      },
      async pluginToggle(opts) {
        if (bridge) return unwrap(await bridge.servers.pluginToggle(opts));
        throw new Error("Server plugins run in the desktop app.");
      },
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
