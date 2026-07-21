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
      async remove(id) {
        if (bridge) return unwrap(await bridge.servers.remove(id));
        sample.servers = sample.servers.filter((x) => x.id !== id); delete sample.serverProps[id]; return true;
      },
    },
  };
})();
