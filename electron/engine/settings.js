// App settings: the launcher's own preferences (memory, Java override, window
// behavior), persisted to settings.json in the app-data dir. Mirrors index.js's
// instance store: plain JSON, read-through on get, merge-and-write on set.
const fs = require("fs");
const path = require("path");
const os = require("os");

let DATA_DIR = null;

const DEFAULTS = {
  defaultRamMB: null,     // MB of RAM to seed new instances with; null = let Lodestone size it
  javaPath: "",           // path to your own Java binary; "" = use the Java Lodestone installs for you
  keepLauncherOpen: true, // keep the launcher window open while Minecraft runs
};

function init(dataDir) { DATA_DIR = dataDir || path.join(os.homedir(), ".lodestone"); }
function settingsFile() { return path.join(DATA_DIR, "settings.json"); }

// Coerce every field to its intended type + sane range, so a hand-edited or
// partial store can never hand the engine a bad value.
function normalize(raw) {
  const s = { ...DEFAULTS, ...(raw || {}) };
  const ram = Number(s.defaultRamMB);
  s.defaultRamMB = (s.defaultRamMB == null || s.defaultRamMB === "" || !Number.isFinite(ram))
    ? null : Math.max(512, Math.round(ram));
  s.javaPath = typeof s.javaPath === "string" ? s.javaPath.trim() : "";
  s.keepLauncherOpen = s.keepLauncherOpen !== false; // anything but an explicit false stays true
  return s;
}

function getSettings() {
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(settingsFile(), "utf8")); } catch {}
  return normalize(stored);
}

function setSettings(patch) {
  const next = normalize({ ...getSettings(), ...(patch || {}) });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

module.exports = { init, getSettings, setSettings };
