// The `lodestone` API handed to a code plugin.
//
// Plugin JS runs in its OWN hidden renderer with nodeIntegration off,
// contextIsolation on and sandbox on — so it gets a browser, not a computer. No
// fs, no child_process, no require. Everything it can actually do goes through
// this bridge to the main process, which re-checks the plugin's declared
// permissions before acting. Checking here too would be theatre: the renderer is
// the untrusted side.
//
// Mirrors the Mac's PluginRuntime API exactly (log/notify/addCommand/on/addTab/
// listInstances/launch/openSection/getData/setData/request) so one plugin's
// main.js runs unmodified on both clients.
const { contextBridge, ipcRenderer } = require("electron");

// Identity arrives via additionalArguments rather than an IPC round-trip, so it
// is fixed before any plugin code runs and cannot be spoofed by the plugin.
const arg = (prefix) => {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
};
const PLUGIN_ID = arg("--plugin-id=");
const PERMISSIONS = new Set((arg("--plugin-perms=") || "").split(",").filter(Boolean));

const call = (method, payload) => ipcRenderer.invoke("plugin:api", { pluginId: PLUGIN_ID, method, payload });

// Handlers the plugin registered, kept here and invoked by id when the main
// process says the command ran or an event fired.
const commands = new Map();
const listeners = new Map();

ipcRenderer.on("plugin:invoke-command", (_e, { id }) => {
  const fn = commands.get(id);
  if (typeof fn === "function") { try { fn(); } catch (e) { call("log", { message: `command ${id} threw: ${e.message}` }); } }
});

// The plugin's code arrives here and is forwarded into the PAGE context to be
// evaluated. It is deliberately not run in this preload: preload can reach
// require("electron"), and evaluating plugin code beside that would hand it the
// keys. postMessage crosses the isolation boundary; require does not.
ipcRenderer.on("plugin:run", (_e, { code }) => {
  window.postMessage({ type: "run", code }, "*");
});

ipcRenderer.on("plugin:event", (_e, { event, data }) => {
  for (const fn of listeners.get(event) || []) {
    try { fn(data); } catch (e) { call("log", { message: `handler for ${event} threw: ${e.message}` }); }
  }
});

// A denied capability throws with the permission name, so a plugin author sees
// what to declare rather than a silent no-op.
function needs(permission) {
  if (!PERMISSIONS.has(permission)) {
    throw new Error(`This plugin didn't declare the "${permission}" permission.`);
  }
}

contextBridge.exposeInMainWorld("lodestone", {
  pluginId: PLUGIN_ID,
  permissions: [...PERMISSIONS],

  log: (message) => call("log", { message: String(message) }),
  notify: (message) => call("notify", { message: String(message) }),

  addCommand: (def) => {
    if (!def || !def.id) throw new Error("addCommand needs an { id, name, callback }.");
    commands.set(def.id, def.callback);
    return call("addCommand", { id: def.id, name: def.name || def.id, icon: def.icon || null });
  },

  on: (event, callback) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(callback);
    return call("subscribe", { event });
  },

  addTab: (def) => {
    if (!def || !def.id) throw new Error("addTab needs an { id, title, html | file }.");
    return call("addTab", { id: def.id, title: def.title || def.id, icon: def.icon || null, html: def.html || null, file: def.file || null });
  },

  listInstances: () => { needs("instances"); return call("listInstances", {}); },
  launch: (instanceId) => { needs("launch"); return call("launch", { instanceId }); },
  openSection: (name) => { needs("ui"); return call("openSection", { name }); },
  getData: (key) => { needs("storage"); return call("getData", { key }); },
  setData: (key, value) => { needs("storage"); return call("setData", { key, value }); },

  // Callback-style to match the Mac: request(url, (err, body) => …). A promise
  // is returned too, so modern plugins can await it instead.
  request: (url, callback) => {
    needs("network");
    const p = call("request", { url: String(url) });
    if (typeof callback === "function") {
      p.then((body) => callback(null, body), (err) => callback(err.message || String(err), null));
    }
    return p;
  },
});
