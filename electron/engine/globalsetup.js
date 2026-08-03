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

// ---- The options.txt keys we expose -----------------------------------------
// Every one of these is a real vanilla options.txt key. `kind` drives the
// control the UI renders: slider / toggle / segmented.
const GAME_FIELDS = [
  { key: "renderDistance",   group: "Video",    label: "Render distance",  desc: "Chunks loaded around you. The single biggest lever on frame rate.", kind: "slider", min: 2, max: 32, step: 1, unit: " chunks" },
  { key: "maxFps",           group: "Video",    label: "Max framerate",    desc: "260 means unlimited.",                                              kind: "slider", min: 10, max: 260, step: 5, unit: " fps" },
  { key: "guiScale",         group: "Video",    label: "GUI scale",        desc: "0 follows your display.",                                            kind: "slider", min: 0, max: 4, step: 1 },
  { key: "gamma",            group: "Video",    label: "Brightness",       desc: "0 is moody, 1 is bright.",                                           kind: "slider", min: 0, max: 1, step: 0.05 },
  { key: "graphicsMode",     group: "Video",    label: "Graphics",         desc: "Fabulous costs the most and only matters with shaders off.",         kind: "segmented", options: [["0", "Fast"], ["1", "Fancy"], ["2", "Fabulous"]] },
  { key: "particles",        group: "Video",    label: "Particles",        desc: "",                                                                   kind: "segmented", options: [["0", "All"], ["1", "Decreased"], ["2", "Minimal"]] },
  { key: "enableVsync",      group: "Video",    label: "VSync",            desc: "Caps frames to your monitor and removes tearing.",                   kind: "toggle" },
  { key: "mouseSensitivity", group: "Controls", label: "Sensitivity",      desc: "0.5 is the vanilla default.",                                        kind: "slider", min: 0, max: 1, step: 0.05 },
  { key: "invertYMouse",     group: "Controls", label: "Invert mouse",     desc: "",                                                                   kind: "toggle" },
  { key: "autoJump",         group: "Controls", label: "Auto-jump",        desc: "",                                                                   kind: "toggle" },
  { key: "toggleCrouch",     group: "Controls", label: "Toggle sneak",     desc: "Hold versus toggle.",                                                kind: "toggle" },
  { key: "toggleSprint",     group: "Controls", label: "Toggle sprint",    desc: "",                                                                   kind: "toggle" },
];

function getGameSettings() {
  return { fields: GAME_FIELDS, values: readJSON(settingsFile(), {}) };
}

function setGameSettings(patch) {
  const current = readJSON(settingsFile(), {});
  for (const [k, v] of Object.entries(patch || {})) {
    if (!GAME_FIELDS.some((f) => f.key === k)) continue;   // ignore unknown keys
    if (v === null || v === undefined) delete current[k];  // null clears the override
    else current[k] = v;
  }
  writeJSON(settingsFile(), current);
  return current;
}

// ---- Global keybind profile -------------------------------------------------
// The catalogue of vanilla actions the global screen can bind, grouped in the
// same order the per-instance manager uses so the two screens read alike.
function keybindCatalogue() {
  const profile = readJSON(keybindsFile(), {});
  const groups = new Map();
  for (const action of Object.keys(keybinds.VANILLA)) {
    const info = keybinds.actionInfo(action);
    if (!groups.has(info.category)) groups.set(info.category, []);
    groups.get(info.category).push({
      action, label: info.label,
      value: profile[action] || null,
      keyLabel: profile[action] ? keybinds.keyLabel(profile[action]) : null,
    });
  }
  return keybinds.CATEGORY_ORDER
    .filter((c) => groups.has(c))
    .map((c) => ({ category: c, binds: groups.get(c) }));
}

function getKeybindProfile() { return { profile: readJSON(keybindsFile(), {}), categories: keybindCatalogue() }; }
function setKeybindProfile({ action, value }) {
  if (!action) throw new Error("Pick an action to rebind.");
  const current = readJSON(keybindsFile(), {});
  if (value === null || value === undefined) delete current[action];
  else current[action] = String(value);
  writeJSON(keybindsFile(), current);
  return current;
}
function resetKeybindProfile() { writeJSON(keybindsFile(), {}); return {}; }

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
  const values = readJSON(settingsFile(), {});
  for (const [k, v] of Object.entries(values)) {
    if (!GAME_FIELDS.some((f) => f.key === k)) continue;
    setOption(doc, k, String(v));
    touched++;
  }

  const binds = readJSON(keybindsFile(), {});
  for (const [action, value] of Object.entries(binds)) {
    if (!/^key\./.test(action)) continue;
    setOption(doc, `key_${action}`, String(value));
    touched++;
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

async function resetSkin(token) {
  if (!token) throw new Error("Sign in with Microsoft to change your skin.");
  return mcRequest({ method: "DELETE", pathname: "/minecraft/profile/skins/active", token });
}

module.exports = {
  init, getGameSettings, setGameSettings,
  getKeybindProfile, setKeybindProfile, resetKeybindProfile, keybindCatalogue,
  applyToInstance, getProfile, uploadSkin, resetSkin, GAME_FIELDS,
};
