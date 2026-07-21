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
  };
})();
