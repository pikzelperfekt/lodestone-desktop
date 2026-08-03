// Themes: the built-in Voxel look, palettes dropped into the themes folder, and
// palettes contributed by enabled plugins.
//
// The JSON shape is byte-identical to the Mac's AppTheme, so a palette written
// for either client works on both — that is the whole point of having a format
// rather than hard-coding colours.
//
// Lodestone ships exactly ONE look on purpose: Voxel *is* the app's identity.
// The chooser exists because hand-dropped and plugin themes join automatically,
// so in a stock install it is a single card confirming what you're wearing.
const fs = require("fs");
const path = require("path");

const plugins = require("./plugins");

let DATA_DIR = null;
function init(dataDir) { DATA_DIR = dataDir; }

function themesDir() {
  const dir = path.join(DATA_DIR, "themes");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* already there */ }
  return dir;
}
function stateFile() { return path.join(themesDir(), ".selected.json"); }

// Values mirror AppThemeCatalog.builtIns[0] exactly.
const VOXEL = {
  id: "voxel", name: "Voxel",
  accent: "#8EC44F", accentDeep: "#79AC3F", onAccent: "#16200E",
  bgTop: "#1B1F1A", bgBottom: "#1B1F1A",
  cornerScale: 0,
  sidebarHex: "#161A15", surfaceHex: "#242A21", titlebarHex: "#20251D",
  textHex: "#E8ECE3", mutedHex: "#9AA591",
  pixelType: true, gridTexture: true, bevel: true, dashedBars: true,
};

// The Mac's Color(hexString:) fallbacks, so a partial palette renders the same
// on both clients instead of drifting.
const FALLBACKS = {
  sidebarHex: "#13141F", surfaceHex: "#232532", titlebarHex: "#1B1D2C",
  textHex: "#E9E9ED", mutedHex: "#8F93A6",
};

const HEX = /^#[0-9a-f]{6}$/i;

// A palette is user-supplied JSON, so every colour is validated before it can
// reach a CSS variable — an unchecked string there is a style-injection hole.
function normalize(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.id || !raw.name) return null;
  const hex = (v, fallback) => (typeof v === "string" && HEX.test(v.trim()) ? v.trim() : fallback);
  const accent = hex(raw.accent, null);
  if (!accent) return null;   // a theme with no accent isn't a theme

  return {
    id: String(raw.id), name: String(raw.name),
    accent,
    accentDeep: hex(raw.accentDeep, accent),
    onAccent: hex(raw.onAccent, "#16200E"),
    bgTop: hex(raw.bgTop, "#1B1F1A"),
    bgBottom: hex(raw.bgBottom, hex(raw.bgTop, "#1B1F1A")),
    sidebarHex: hex(raw.sidebarHex, FALLBACKS.sidebarHex),
    surfaceHex: hex(raw.surfaceHex, FALLBACKS.surfaceHex),
    titlebarHex: hex(raw.titlebarHex, FALLBACKS.titlebarHex),
    textHex: hex(raw.textHex, FALLBACKS.textHex),
    mutedHex: hex(raw.mutedHex, FALLBACKS.mutedHex),
    cornerScale: Number.isFinite(Number(raw.cornerScale)) ? Number(raw.cornerScale) : 1,
    pixelType: raw.pixelType === true,
    gridTexture: raw.gridTexture === true,
    bevel: raw.bevel === true,
    dashedBars: raw.dashedBars === true,
  };
}

function diskThemes() {
  let files = [];
  try { files = fs.readdirSync(themesDir()).filter((f) => f.toLowerCase().endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (f.startsWith(".")) continue;   // .selected.json is state, not a palette
    try {
      const t = normalize(JSON.parse(fs.readFileSync(path.join(themesDir(), f), "utf8")));
      if (t) out.push({ ...t, source: "folder" });
    } catch { /* a palette that won't parse is skipped, not fatal */ }
  }
  return out;
}

// Built-ins, then folder, then plugins — deduped by id, first wins, so a plugin
// re-using "voxel" cannot silently replace the app's own look.
function available() {
  const seen = new Set();
  const out = [];
  const pluginThemes = plugins.contributedThemes()
    .map(normalize).filter(Boolean).map((t) => ({ ...t, source: "plugin" }));

  for (const t of [{ ...VOXEL, source: "built-in" }, ...diskThemes(), ...pluginThemes]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

function selectedId() {
  try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")).id || VOXEL.id; } catch { return VOXEL.id; }
}

// The selection can dangle — the plugin that owned it may have been disabled, or
// its file deleted — so it is resolved against what actually exists right now.
function current() {
  const all = available();
  return all.find((t) => t.id === selectedId()) || all[0] || { ...VOXEL, source: "built-in" };
}

function select(id) {
  const all = available();
  const hit = all.find((t) => t.id === id);
  if (!hit) throw new Error("That theme isn't available any more.");
  fs.writeFileSync(stateFile(), JSON.stringify({ id: hit.id }, null, 2));
  return hit;
}

function list() { return { themes: available(), currentId: current().id, dir: themesDir() }; }

module.exports = { init, list, available, current, select, themesDir, normalize, VOXEL };
