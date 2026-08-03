// Global Game settings + Keybinds, and Skins — the Mac app's SETUP section.
//
// GAME SETTINGS / KEYBINDS
// Both are "apply to every instance" profiles. They live as JSON in the data
// dir and are stamped into each instance's options.txt at launch, reusing
// packs.js's byte-preserving line-file helpers so every other line in that
// file keeps its exact bytes. This mirrors the Mac model: the profile is the
// source of truth, applying happens on the launch path, and an instance that
// overrides a key locally still wins (see applyToInstance).
//
// Nothing here writes a value the user has not set. An unset field is absent
// from the JSON and is never stamped, so a fresh install does not silently
// rewrite anyone's in-game settings.
const fs = require("fs");
const path = require("path");
const https = require("https");
const { instanceDir, readOptions, writeLineFile, setOption, removeOptions } = require("./packs");
const keybinds = require("./keybinds");

let DATA_DIR = null;
function init(dataDir) { DATA_DIR = dataDir; }

const settingsFile = () => path.join(DATA_DIR, "game-settings.json");
const keybindsFile = () => path.join(DATA_DIR, "keybinds-profile.json");

function readJSON(file, fallback) {
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return j && typeof j === "object" ? j : fallback; }
  catch { return fallback; }
}
function writeJSON(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }

// ---- The settings catalogue --------------------------------------------------
// Ported 1:1 from the Mac GameSettingsCatalog: same options.txt keys, same
// names, same categories, same vanilla defaults. `style` only governs how a
// raw value is DISPLAYED — the stored value is always Minecraft's own form.
const GAME_FIELDS = [
  // Video
  { key: "fov",            label: "Field of View", group: "Video", kind: "slider", min: 0, max: 1,   step: 0.05, style: "fov",         def: "0.5" },
  { key: "renderDistance", label: "Render Distance", group: "Video", kind: "slider", min: 2, max: 32, step: 1,   style: "integer",     def: "12" },
  { key: "guiScale",       label: "GUI Scale",     group: "Video", kind: "option", values: ["0", "1", "2", "3", "4"], labels: ["Auto", "1", "2", "3", "4"], def: "0" },
  { key: "maxFps",         label: "Max Framerate", group: "Video", kind: "slider", min: 10, max: 260, step: 5,   style: "maxFps",      def: "120" },
  { key: "gamma",          label: "Brightness",    group: "Video", kind: "slider", min: 0, max: 1,   step: 0.05, style: "percent",     def: "0.5" },
  { key: "bobView",        label: "View Bobbing",  group: "Video", kind: "toggle", def: "true" },
  { key: "entityShadows",  label: "Entity Shadows", group: "Video", kind: "toggle", def: "true" },
  { key: "fullscreen",     label: "Fullscreen",    group: "Video", kind: "toggle", def: "false" },

  // Controls
  { key: "mouseSensitivity", label: "Mouse Sensitivity", group: "Controls", kind: "slider", min: 0, max: 1, step: 0.05, style: "sensitivity", def: "0.5" },
  { key: "invertYMouse",     label: "Invert Mouse",      group: "Controls", kind: "toggle", def: "false" },
  { key: "autoJump",         label: "Auto-Jump",         group: "Controls", kind: "toggle", def: "false" },

  // Sound — Minecraft's exact category ids.
  { key: "soundCategory_master",  label: "Master Volume",        group: "Sound", kind: "slider", min: 0, max: 1, step: 0.05, style: "percent", def: "1.0" },
  { key: "soundCategory_music",   label: "Music",                group: "Sound", kind: "slider", min: 0, max: 1, step: 0.05, style: "percent", def: "1.0" },
  { key: "soundCategory_record",  label: "Jukebox / Note Blocks", group: "Sound", kind: "slider", min: 0, max: 1, step: 0.05, style: "percent", def: "1.0" },
  { key: "soundCategory_weather", label: "Weather",              group: "Sound", kind: "slider", min: 0, max: 1, step: 0.05, style: "percent", def: "1.0" },
  { key: "soundCategory_block",   label: "Blocks",               group: "Sound", kind: "slider", min: 0, max: 1, step: 0.05, style: "percent", def: "1.0" },
  { key: "soundCategory_hostile", label: "Hostile Creatures",    group: "Sound", kind: "slider", min: 0, max: 1, step: 0.05, style: "percent", def: "1.0" },
  { key: "soundCategory_neutral", label: "Friendly Creatures",   group: "Sound", kind: "slider", min: 0, max: 1, step: 0.05, style: "percent", def: "1.0" },
  { key: "soundCategory_player",  label: "Players",              group: "Sound", kind: "slider", min: 0, max: 1, step: 0.05, style: "percent", def: "1.0" },
  { key: "soundCategory_ambient", label: "Ambient / Environment", group: "Sound", kind: "slider", min: 0, max: 1, step: 0.05, style: "percent", def: "1.0" },
  { key: "soundCategory_voice",   label: "Voice / Speech",       group: "Sound", kind: "slider", min: 0, max: 1, step: 0.05, style: "percent", def: "1.0" },
];

// Minecraft writes 1.0 / 0.5 / 0.55 / 12 — match that exactly, because the file
// is round-tripped by the game and a stray 0.550000001 is noise in a diff.
function storedString(field, v) {
  if (field.style === "integer" || field.style === "maxFps") return String(Math.round(v));
  const rounded = Math.round(v * 100) / 100;
  if (rounded === Math.round(rounded)) return rounded.toFixed(1);
  if (Math.round(rounded * 10) === rounded * 10) return rounded.toFixed(1);
  return rounded.toFixed(2);
}

function getGameSettings() {
  const stored = readJSON(settingsFile(), {});
  return {
    fields: GAME_FIELDS,
    values: stored.values || {},
    applyOnLaunch: stored.applyOnLaunch !== false,
  };
}

function setApplyOnLaunch(on) {
  const stored = readJSON(settingsFile(), {});
  stored.values = stored.values || {};
  stored.applyOnLaunch = !!on;
  writeJSON(settingsFile(), stored);
  return stored.applyOnLaunch;
}

function setGameSettings(patch) {
  const stored = readJSON(settingsFile(), {});
  stored.values = stored.values || {};
  for (const [k, v] of Object.entries(patch || {})) {
    const field = GAME_FIELDS.find((f) => f.key === k);
    if (!field) continue;                                       // ignore unknown keys
    if (v === null || v === undefined) { delete stored.values[k]; continue; }  // clear the override
    stored.values[k] = field.kind === "slider" ? storedString(field, Number(v)) : String(v);
  }
  writeJSON(settingsFile(), stored);
  return stored.values;
}

// ---- Keybind library -------------------------------------------------------
// Ported from the Mac KeybindManager. Three ideas the first pass missed:
//
//   1. MOD KEYBINDS ARE DISCOVERED, not hardcoded. Every instance's options.txt
//      lists its own key_* lines, so scanning the instances you have actually
//      launched is what surfaces Iris, JourneyMap, TACZ and the rest. A fixed
//      vanilla table can never know about them.
//   2. PRESETS. Several named sets of binds, one of them the base.
//   3. Binds can be DISABLED individually without being forgotten.
function keybindStore() {
  const raw = readJSON(keybindsFile(), {});
  if (!raw.presets) {
    // Migrate the flat {action: value} shape the first version wrote.
    return {
      presets: [{ id: "default", name: "Default", base: true, binds: raw.binds || raw || {}, disabled: [] }],
      activeId: "default",
      applyOnLaunch: true,
      discovered: {},
    };
  }
  return {
    presets: raw.presets,
    activeId: raw.activeId || (raw.presets[0] && raw.presets[0].id) || "default",
    applyOnLaunch: raw.applyOnLaunch !== false,
    discovered: raw.discovered || {},
  };
}
function saveKeybindStore(store) { writeJSON(keybindsFile(), store); }
const activePreset = (store) =>
  store.presets.find((p) => p.id === store.activeId) || store.presets[0];

// Walk every instance's options.txt and collect the key_* actions it knows
// about. This is how mod keybinds enter the library at all.
function discoverBindings(dataDir) {
  const found = {};
  let ids = [];
  try { ids = fs.readdirSync(path.join(dataDir, "instances"), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name); } catch { return found; }
  for (const id of ids) {
    let doc;
    try { doc = readOptions(instanceDir(dataDir, id)); } catch { continue; }
    if (!doc || !doc.exists) continue;
    for (const part of doc.parts) {
      const m = /^key_([^:]+):(.*)$/.exec(part.text);
      if (!m) continue;
      const action = m[1];
      if (!found[action]) found[action] = m[2];
    }
  }
  return found;
}

function refreshDiscovered(dataDir) {
  const store = keybindStore();
  store.discovered = { ...store.discovered, ...discoverBindings(dataDir) };
  saveKeybindStore(store);
  return Object.keys(store.discovered).length;
}

// Group an action id into a category. Vanilla actions use the manager's own
// table; a mod bind (key.<modid>.<thing>) is grouped under its mod id, which is
// exactly how the Mac screen reads.
function categoryFor(action) {
  const info = keybinds.actionInfo(action);
  if (keybinds.VANILLA[action]) return info.category;
  const m = /^key\.([a-z0-9_]+)\./i.exec(action);
  if (m && m[1] !== "keyboard" && m[1] !== "mouse") return m[1].toUpperCase();
  return "Mods & Other";
}

function getKeybindProfile() {
  const store = keybindStore();
  const preset = activePreset(store);
  const actions = new Set([
    ...Object.keys(keybinds.VANILLA),
    ...Object.keys(store.discovered || {}),
    ...Object.keys(preset.binds || {}),
  ]);
  const disabled = new Set(preset.disabled || []);

  const rows = [...actions].map((action) => {
    const value = preset.binds[action] || store.discovered[action] || null;
    return {
      action,
      category: categoryFor(action),
      label: keybinds.actionInfo(action).label,
      value,
      keyLabel: value ? keybinds.keyLabel(value) : null,
      bound: Object.prototype.hasOwnProperty.call(preset.binds, action),
      disabled: disabled.has(action),
    };
  });

  // Vanilla first (in the manager's category order), then mod groups A-Z, and
  // alphabetical inside each — a stable order so a row never jumps under you.
  const order = keybinds.CATEGORY_ORDER;
  rows.sort((a, b) => {
    const ai = order.indexOf(a.category), bi = order.indexOf(b.category);
    const av = ai < 0 ? 999 : ai, bv = bi < 0 ? 999 : bi;
    if (av !== bv) return av - bv;
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.label.localeCompare(b.label);
  });

  // Two actions on the same key fight in game; surface that rather than let the
  // player discover it mid-fight.
  const byKey = {};
  for (const r of rows) {
    if (!r.value || r.disabled || /unknown$/.test(r.value)) continue;
    (byKey[r.value] = byKey[r.value] || []).push(r.action);
  }
  const conflicts = Object.entries(byKey)
    .filter(([, list]) => list.length > 1)
    .map(([value, actions]) => ({ value, keyLabel: keybinds.keyLabel(value), actions }));

  return {
    rows, conflicts,
    presets: store.presets.map((p) => ({ id: p.id, name: p.name, base: !!p.base, count: Object.keys(p.binds || {}).length })),
    activeId: store.activeId,
    applyOnLaunch: store.applyOnLaunch,
    discoveredCount: Object.keys(store.discovered || {}).length,
    disabledCount: (preset.disabled || []).length,
  };
}

function setKeybindProfile({ action, value }) {
  if (!action) throw new Error("Pick an action to rebind.");
  const store = keybindStore();
  const preset = activePreset(store);
  if (value === null || value === undefined) delete preset.binds[action];
  else preset.binds[action] = String(value);
  saveKeybindStore(store);
  return getKeybindProfile();
}

function setKeybindDisabled({ action, disabled }) {
  const store = keybindStore();
  const preset = activePreset(store);
  const set = new Set(preset.disabled || []);
  if (disabled) set.add(action); else set.delete(action);
  preset.disabled = [...set];
  saveKeybindStore(store);
  return getKeybindProfile();
}

function setKeybindApply(on) {
  const store = keybindStore();
  store.applyOnLaunch = !!on;
  saveKeybindStore(store);
  return store.applyOnLaunch;
}

function keybindPreset({ verb, id, name }) {
  const store = keybindStore();
  if (verb === "select") { if (store.presets.some((p) => p.id === id)) store.activeId = id; }
  else if (verb === "create") {
    const newId = "p" + Date.now().toString(36);
    store.presets.push({ id: newId, name: (name || "New preset").trim(), base: false, binds: {}, disabled: [] });
    store.activeId = newId;
  } else if (verb === "duplicate") {
    const src = activePreset(store);
    const newId = "p" + Date.now().toString(36);
    store.presets.push({ id: newId, name: `${src.name} copy`, base: false, binds: { ...src.binds }, disabled: [...(src.disabled || [])] });
    store.activeId = newId;
  } else if (verb === "rename") {
    const p = store.presets.find((x) => x.id === (id || store.activeId));
    if (p && name && name.trim()) p.name = name.trim();
  } else if (verb === "delete") {
    if (store.presets.length < 2) throw new Error("Keep at least one preset.");
    const target = id || store.activeId;
    if (store.presets.find((p) => p.id === target && p.base)) throw new Error("The base preset can't be deleted.");
    store.presets = store.presets.filter((p) => p.id !== target);
    if (store.activeId === target) store.activeId = store.presets[0].id;
  }
  saveKeybindStore(store);
  return getKeybindProfile();
}

function resetKeybindProfile() {
  const store = keybindStore();
  const preset = activePreset(store);
  preset.binds = {}; preset.disabled = [];
  saveKeybindStore(store);
  return getKeybindProfile();
}

// ---- Apply both to an instance, on the launch path --------------------------
// Called right before the JVM starts. Values are only written when the profile
// actually defines them.
function applyToInstance(instanceId) {
  if (!DATA_DIR) return;
  const dir = instanceDir(DATA_DIR, instanceId);
  let doc;
  try { doc = readOptions(dir); } catch { return; }
  if (!doc) return;

  let touched = 0;
  const stored = readJSON(settingsFile(), {});
  // The master switch: off means the profile exists but is not enforced.
  const values = stored.applyOnLaunch === false ? {} : (stored.values || {});
  for (const [k, v] of Object.entries(values)) {
    if (!GAME_FIELDS.some((f) => f.key === k)) continue;
    setOption(doc, k, String(v));
    touched++;
  }

  const kb = keybindStore();
  if (kb.applyOnLaunch !== false) {
    const preset = activePreset(kb);
    const off = new Set(preset.disabled || []);
    for (const [action, value] of Object.entries(preset.binds || {})) {
      if (!/^key\./.test(action) || off.has(action)) continue;
      setOption(doc, `key_${action}`, String(value));
      touched++;
    }
  }

  // Nothing configured: leave the file (or its absence) completely alone
  // rather than creating an empty options.txt on every launch.
  if (!touched) return;
  try { writeLineFile(doc); } catch { /* settings are cosmetic; never block a launch */ }
}

// ---- Skins ------------------------------------------------------------------
// Real Minecraft Services API calls with the signed-in MSA token. Changing a
// skin is an account-level action, so it needs a live token, not the offline
// session — callers pass one in rather than this module reaching into auth.
function mcRequest({ method, pathname, token, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: "api.minecraftservices.com", path: pathname, method,
      headers: { Authorization: `Bearer ${token}`, ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(text ? JSON.parse(text) : {}); } catch { resolve({}); }
        } else if (res.statusCode === 401) {
          reject(new Error("Your Microsoft session expired. Sign out and back in, then try again."));
        } else {
          reject(new Error(`Minecraft rejected that (${res.statusCode}). ${text.slice(0, 160)}`));
        }
      });
    });
    req.on("error", (e) => reject(new Error("Couldn't reach Minecraft services: " + e.message)));
    if (body) req.write(body);
    req.end();
  });
}

async function getProfile(token) {
  if (!token) throw new Error("Sign in with Microsoft to manage your skin.");
  return mcRequest({ method: "GET", pathname: "/minecraft/profile", token });
}

// Multipart upload — the skins endpoint takes a file part, not JSON.
async function uploadSkin({ token, dataBase64, variant }) {
  if (!token) throw new Error("Sign in with Microsoft to change your skin.");
  const buf = Buffer.from(String(dataBase64 || ""), "base64");
  if (!buf.length) throw new Error("That image was empty.");
  // A Minecraft skin is a 64x64 (or legacy 64x32) PNG. Check the magic bytes
  // so an obviously wrong file fails here with a clear line instead of a 400.
  if (buf.slice(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Pick a PNG file — skins have to be PNG.");

  const boundary = "----lodestone" + Date.now().toString(16);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="variant"\r\n\r\n${variant === "slim" ? "slim" : "classic"}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skin.png"\r\nContent-Type: image/png\r\n\r\n`, "utf8");
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([head, buf, tail]);

  return mcRequest({
    method: "POST", pathname: "/minecraft/profile/skins", token,
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length },
    body,
  });
}

// ---- Skin library -----------------------------------------------------------
// Skins you've worn, kept locally so switching back doesn't mean finding the
// PNG again. Applying one re-uploads it to your Microsoft account, because
// that is the only place a skin actually lives.
function skinsDir() { return path.join(DATA_DIR, "skins"); }
function skinManifest() { return path.join(skinsDir(), "skins.json"); }
function readSkins() {
  try { const j = JSON.parse(fs.readFileSync(skinManifest(), "utf8")); return Array.isArray(j) ? j : []; }
  catch { return []; }
}
function writeSkins(list) {
  fs.mkdirSync(skinsDir(), { recursive: true });
  try { fs.writeFileSync(skinManifest(), JSON.stringify(list, null, 2)); } catch { /* best effort */ }
}

function listSkins() {
  // Drop entries whose file has gone, so the library can't show a dead tile.
  const rows = readSkins().filter((sk) => { try { return fs.existsSync(path.join(skinsDir(), sk.file)); } catch { return false; } });
  if (rows.length !== readSkins().length) writeSkins(rows);
  return rows.map((sk) => ({ ...sk, path: path.join(skinsDir(), sk.file) }));
}

function saveSkin({ dataBase64, variant, name }) {
  const buf = Buffer.from(String(dataBase64 || ""), "base64");
  if (!buf.length) throw new Error("That image was empty.");
  if (buf.slice(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Skins have to be PNG.");
  fs.mkdirSync(skinsDir(), { recursive: true });
  // Date.now() alone collides when two skins are saved in the same
  // millisecond — the second overwrote the first's file, so deleting either
  // destroyed both. The random suffix makes the id genuinely unique.
  const id = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const file = `${id}.png`;
  fs.writeFileSync(path.join(skinsDir(), file), buf);
  const rows = readSkins();
  rows.unshift({ id, file, name: String(name || "Skin").slice(0, 60),
                 variant: variant === "slim" ? "slim" : "classic", savedAt: Date.now() });
  writeSkins(rows);
  return listSkins();
}

function removeSkin({ id }) {
  const rows = readSkins();
  const hit = rows.find((sk) => sk.id === id);
  if (hit) { try { fs.rmSync(path.join(skinsDir(), hit.file), { force: true }); } catch { /* already gone */ } }
  writeSkins(rows.filter((sk) => sk.id !== id));
  return listSkins();
}

function renameSkin({ id, name }) {
  const rows = readSkins();
  const hit = rows.find((sk) => sk.id === id);
  if (!hit) throw new Error("Skin not found.");
  hit.name = String(name || hit.name).slice(0, 60);
  writeSkins(rows);
  return listSkins();
}

// Apply one from the library: read it back off disk and upload it.
async function applySkin({ token, id }) {
  const hit = readSkins().find((sk) => sk.id === id);
  if (!hit) throw new Error("Skin not found.");
  const buf = fs.readFileSync(path.join(skinsDir(), hit.file));
  return uploadSkin({ token, dataBase64: buf.toString("base64"), variant: hit.variant });
}

async function resetSkin(token) {
  if (!token) throw new Error("Sign in with Microsoft to change your skin.");
  return mcRequest({ method: "DELETE", pathname: "/minecraft/profile/skins/active", token });
}

module.exports = {
  init, getGameSettings, setGameSettings,
  getKeybindProfile, setKeybindProfile, resetKeybindProfile,
  setKeybindDisabled, setKeybindApply, keybindPreset, refreshDiscovered,
  applyToInstance, getProfile, uploadSkin, resetSkin, GAME_FIELDS,
  listSkins, saveSkin, removeSkin, renameSkin, applySkin,
};
