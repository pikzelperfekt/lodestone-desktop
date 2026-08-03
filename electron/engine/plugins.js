// Plugins: scan, enable/disable, browse the community list, install from GitHub.
//
// Ported from the Mac's PluginStore + PluginRegistry + PluginInstaller so a
// plugin published once works on both clients from the same GitHub release.
//
// A plugin is a folder under <dataDir>/plugins/<id>/ containing plugin.json (or
// Obsidian-style manifest.json). Plugins can be DECLARATIVE (contribute themes
// and note/link tabs — no code at all) and/or CODE plugins, where `main` points
// at a main.js that runs sandboxed and drives the app through the `lodestone`
// API, gated by the permissions the manifest declares.
const fs = require("fs");
const path = require("path");

// Same curated list the Mac reads, so the two clients show the same catalogue.
const REGISTRY_URL = "https://raw.githubusercontent.com/pikzelperfekt/lodestone-plugins/main/community-plugins.json";

const PERMISSIONS = {
  network:   { label: "Network",          blurb: "Make web requests to any URL." },
  instances: { label: "Read instances",   blurb: "See your list of instances." },
  launch:    { label: "Launch the game",  blurb: "Start Minecraft for an instance." },
  storage:   { label: "Save plugin data", blurb: "Persist its own settings/data." },
  ui:        { label: "Navigate the app", blurb: "Switch between app sections." },
};

let DATA_DIR = null;
function init(dataDir) { DATA_DIR = dataDir; }

function pluginsDir() {
  const dir = path.join(DATA_DIR, "plugins");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* already there */ }
  return dir;
}
function stateFile() { return path.join(pluginsDir(), ".state.json"); }

// Which plugins the user switched off. Stored as a disabled-list so a freshly
// installed plugin is on by default, matching the Mac.
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch { return { disabled: [], data: {} }; }
}
function writeState(s) { fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2)); }

// A plugin id becomes a folder name, so it must never escape the plugins dir.
// "../../etc" in a manifest would otherwise write anywhere on disk.
function safeId(id) {
  const clean = String(id || "").trim();
  if (!clean || clean !== path.basename(clean) || clean === "." || clean === "..") {
    throw new Error(`Unsafe plugin id: ${JSON.stringify(id)}`);
  }
  return clean;
}

function readManifest(folder) {
  for (const name of ["plugin.json", "manifest.json"]) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(folder, name), "utf8"));
      if (m && m.id && m.name) return m;
    } catch { /* try the other name */ }
  }
  return null;
}

function list() {
  const dir = pluginsDir();
  const state = readState();
  const disabled = new Set(state.disabled || []);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const folder = path.join(dir, e.name);
    const manifest = readManifest(folder);
    if (!manifest) continue;
    out.push({
      manifest,
      id: manifest.id,
      folder,
      enabled: !disabled.has(manifest.id),
      isCode: !!manifest.main,
      permissions: (manifest.permissions || []).filter((p) => PERMISSIONS[p]),
    });
  }
  return out.sort((a, b) => String(a.manifest.name).localeCompare(String(b.manifest.name), undefined, { sensitivity: "base" }));
}

function setEnabled(id, enabled) {
  const state = readState();
  const disabled = new Set(state.disabled || []);
  if (enabled) disabled.delete(id); else disabled.add(id);
  state.disabled = [...disabled];
  writeState(state);
  return list();
}

// ---- per-plugin key/value storage (the `storage` permission) ----------------
function getData(pluginId, key) {
  const state = readState();
  return ((state.data || {})[pluginId] || {})[key] ?? null;
}
function setData(pluginId, key, value) {
  const state = readState();
  state.data = state.data || {};
  state.data[pluginId] = state.data[pluginId] || {};
  state.data[pluginId][key] = value;
  writeState(state);
  return true;
}

// ---- what enabled plugins contribute ---------------------------------------
function contributedThemes() {
  const out = [];
  for (const p of list()) {
    if (!p.enabled) continue;
    for (const rel of p.manifest.themes || []) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(p.folder, rel), "utf8"))); }
      catch { /* a theme that won't parse is skipped, not fatal */ }
    }
  }
  return out;
}

// Declarative tabs from the manifest. Code plugins add theirs at runtime through
// lodestone.addTab(), which the host merges on top of these.
function contributedTabs() {
  const out = [];
  for (const p of list()) {
    if (!p.enabled) continue;
    for (const tab of p.manifest.tabs || []) {
      out.push({
        id: `plugin-${p.id}-${tab.id}`,
        pluginId: p.id,
        title: tab.title,
        icon: tab.icon || null,
        kind: tab.kind === "link" ? "link" : "note",
        url: tab.url || null,
        content: tab.content || null,
      });
    }
  }
  return out;
}

// ---- community registry + GitHub install ------------------------------------
async function community() {
  const res = await fetch(REGISTRY_URL);
  if (!res.ok) throw new Error(`Couldn't load the plugin list (HTTP ${res.status}).`);
  const json = await res.json();
  return Array.isArray(json) ? json : [];
}

async function latestRelease(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Lodestone" },
  });
  if (res.status === 404) throw new Error(`${repo} has no published releases.`);
  if (!res.ok) throw new Error(`GitHub said HTTP ${res.status} for ${repo}.`);
  return res.json();
}

// Install (or update) the plugin published at owner/name. Files land in
// plugins/<id>/; the manifest is written under BOTH names so either loader
// convention finds it.
async function install(repo) {
  const clean = String(repo || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(clean)) throw new Error(`That doesn't look like a GitHub repo: ${repo}`);

  const release = await latestRelease(clean);
  const assets = release.assets || [];
  const manifestAsset = assets.find((a) => a.name === "manifest.json") || assets.find((a) => a.name === "plugin.json");
  if (!manifestAsset) throw new Error("That release has no manifest.json.");

  const mRes = await fetch(manifestAsset.browser_download_url, { headers: { "User-Agent": "Lodestone" } });
  if (!mRes.ok) throw new Error("Couldn't download that plugin's manifest.");
  let manifest;
  try { manifest = JSON.parse(await mRes.text()); } catch { throw new Error("That plugin's manifest.json couldn't be read."); }
  if (!manifest || !manifest.id || !manifest.name) throw new Error("That plugin's manifest.json is missing id or name.");
  // Remember where it came from so updating works even if the manifest omitted it.
  if (!manifest.repo) manifest.repo = clean;

  const dir = path.join(pluginsDir(), safeId(manifest.id));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const saved = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(path.join(dir, "plugin.json"), saved);
  fs.writeFileSync(path.join(dir, "manifest.json"), saved);

  for (const asset of assets) {
    if (asset.name === "manifest.json" || asset.name === "plugin.json") continue;
    // An asset name is attacker-controlled; keep it to a bare filename so a
    // crafted release can't write outside the plugin's own folder.
    const base = path.basename(String(asset.name));
    if (!base || base === "." || base === "..") continue;
    const res = await fetch(asset.browser_download_url, { headers: { "User-Agent": "Lodestone" } });
    if (!res.ok) continue;
    fs.writeFileSync(path.join(dir, base), Buffer.from(await res.arrayBuffer()));
  }
  return manifest;
}

function remove(id, trash) {
  const dir = path.join(pluginsDir(), safeId(id));
  if (trash) return trash(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// The JS a code plugin ships, read for the sandboxed host to evaluate.
function mainScript(id) {
  const plugin = list().find((p) => p.id === id);
  if (!plugin || !plugin.manifest.main) return null;
  const file = path.join(plugin.folder, path.basename(String(plugin.manifest.main)));
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

module.exports = {
  init, pluginsDir, list, setEnabled, remove, install, community, latestRelease,
  contributedThemes, contributedTabs, getData, setData, mainScript, readManifest,
  PERMISSIONS, REGISTRY_URL, safeId,
};
