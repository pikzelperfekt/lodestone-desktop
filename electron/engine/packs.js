// Resource pack / shader pack / datapack managers for an instance.
// - Resource packs: list <instance>/resourcepacks/ with pack.mcmeta metadata,
//   enable/disable/reorder via the `resourcePacks` JSON array in options.txt.
// - Shader packs: list <instance>/shaderpacks/; the active shader is the
//   `shaderPack=` line in config/iris.properties or config/oculus.properties
//   (whichever exists — list-only when neither does).
// - Datapacks: per world, under <instance>/saves/<world>/datapacks/.
// Every options.txt / .properties edit is line-surgical: untouched lines keep
// their exact bytes (including their CRLF/LF terminators), so the game never
// sees a rewritten file. adm-zip (already a dependency) reads pack.mcmeta and
// pack.png straight out of .zip packs without extracting.
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

function instanceDir(dataDir, instanceId) { return path.join(dataDir, "instances", instanceId); }

// A single, safe path segment (same guard worlds.js uses): no separators, no
// "." / ".." traversal, so a crafted name can't escape the instance folder.
function safeName(name) {
  const raw = String(name == null ? "" : name).trim();
  const base = path.basename(raw);
  if (!base || base === "." || base === ".." || raw.includes("/") || raw.includes("\\")) {
    throw new Error("Invalid name.");
  }
  return base;
}

// ---- Byte-preserving line files (options.txt and .properties) ----
// splitLines/joinLines round-trip any text exactly: each part keeps its own
// terminator ("\r\n", "\n", or "" for a final unterminated line), so editing
// one line never rewrites the others.
function splitLines(raw) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\n") {
      const crlf = i > start && raw[i - 1] === "\r";
      parts.push({ text: raw.slice(start, crlf ? i - 1 : i), eol: crlf ? "\r\n" : "\n" });
      start = i + 1;
    }
  }
  if (start < raw.length) parts.push({ text: raw.slice(start), eol: "" });
  return parts;
}
function joinLines(parts) { return parts.map((p) => p.text + p.eol).join(""); }

// Load a key/value line file. `exists:false` (never a throw) when it's absent —
// an instance that has never launched has no options.txt yet.
function readLineFile(file) {
  let raw = null;
  try { raw = fs.readFileSync(file, "utf8"); } catch {}
  if (raw == null) return { exists: false, file, parts: [], eol: "\n" };
  return { exists: true, file, parts: splitLines(raw), eol: raw.includes("\r\n") ? "\r\n" : "\n" };
}
function writeLineFile(doc) { fs.writeFileSync(doc.file, joinLines(doc.parts)); }

// options.txt is `key:value` per line (first colon splits; values may be JSON).
function optionsFile(dir) { return path.join(dir, "options.txt"); }
function readOptions(dir) { return readLineFile(optionsFile(dir)); }
function getOption(doc, key) {
  const prefix = key + ":";
  const part = doc.parts.find((p) => p.text.startsWith(prefix));
  return part ? part.text.slice(prefix.length) : null;
}
function setOption(doc, key, value) {
  const prefix = key + ":";
  const part = doc.parts.find((p) => p.text.startsWith(prefix));
  if (part) { part.text = prefix + value; return; }
  const last = doc.parts[doc.parts.length - 1];
  if (last && last.eol === "") last.eol = doc.eol;   // terminate the final line before appending
  doc.parts.push({ text: prefix + value, eol: doc.eol });
}
function removeOptions(doc, predicate) {
  const before = doc.parts.length;
  doc.parts = doc.parts.filter((p) => !predicate(p.text));
  return before - doc.parts.length;
}

// .properties is `key=value` per line, `#` comments (Iris/Oculus configs).
// Values get a light backslash-unescape on read; names Windows allows never
// need escaping on write.
function getProp(doc, key) {
  const prefix = key + "=";
  const part = doc.parts.find((p) => !p.text.startsWith("#") && p.text.startsWith(prefix));
  return part ? part.text.slice(prefix.length).replace(/\\(.)/g, "$1") : null;
}
function setProp(doc, key, value) {
  const prefix = key + "=";
  const part = doc.parts.find((p) => !p.text.startsWith("#") && p.text.startsWith(prefix));
  if (part) { part.text = prefix + value; return; }
  const last = doc.parts[doc.parts.length - 1];
  if (last && last.eol === "") last.eol = doc.eol;
  doc.parts.push({ text: prefix + value, eol: doc.eol });
}

// ---- Pack folders ----
const KIND_DIRS = { resourcepack: "resourcepacks", shader: "shaderpacks" };

// Absolute folder for a pack kind (datapacks live inside a world). Creates it on
// demand — a fresh instance has none of these folders yet. For datapacks the
// world itself must already exist; only the datapacks subfolder is created.
function packsFolder(dataDir, instanceId, kind, world) {
  const idir = instanceDir(dataDir, instanceId);
  let dir;
  if (kind === "datapack") {
    const w = safeName(world);
    const worldDir = path.join(idir, "saves", w);
    if (!fs.existsSync(worldDir)) throw new Error(`World "${w}" not found.`);
    dir = path.join(worldDir, "datapacks");
  } else {
    const sub = KIND_DIRS[kind];
    if (!sub) throw new Error("Unknown pack kind.");
    dir = path.join(idir, sub);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- pack.mcmeta / pack.png metadata ----
// A description can be a plain string or a text component (object / array);
// flatten to the readable text.
function flattenText(d) {
  if (d == null) return "";
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map(flattenText).join("");
  if (typeof d === "object") return flattenText(d.text) + flattenText(d.extra);
  return String(d);
}
function parseMcmeta(buf) {
  try {
    const json = JSON.parse(buf.toString("utf8").replace(/^\uFEFF/, ""));
    const pack = json.pack || {};
    return {
      packFormat: pack.pack_format != null ? Number(pack.pack_format) : null,
      description: flattenText(pack.description).trim() || null,
      malformed: false,
    };
  } catch {
    return { packFormat: null, description: null, malformed: true };  // show filename, skip metadata
  }
}

const ICON_MAX = 262144;   // pack.png larger than 256 KB stays un-inlined
function iconDataURI(buf) {
  if (!buf || buf.length === 0 || buf.length > ICON_MAX) return null;
  return "data:image/png;base64," + buf.toString("base64");
}

// Metadata for one pack (zip file or folder pack). `withMeta` is false for
// shaders — shader zips have no pack.mcmeta, so absence there isn't noteworthy.
function packInfo(dir, name, withMeta) {
  const full = path.join(dir, name);
  let st;
  try { st = fs.statSync(full); } catch { return null; }
  const isDir = st.isDirectory();
  const base = {
    fileName: name, isDir,
    size: isDir ? 0 : st.size,
    modified: st.mtimeMs,
    packFormat: null, description: null, malformed: false, missingMeta: false, icon: null,
  };
  if (isDir) {
    if (withMeta) {
      const metaFile = path.join(full, "pack.mcmeta");
      if (fs.existsSync(metaFile)) {
        try { Object.assign(base, parseMcmeta(fs.readFileSync(metaFile))); }
        catch { base.malformed = true; }
      } else base.missingMeta = true;
    }
    try { base.icon = iconDataURI(fs.readFileSync(path.join(full, "pack.png"))); } catch {}
    return base;
  }
  if (!/\.zip$/i.test(name)) return null;
  try {
    const zip = new AdmZip(full);
    if (withMeta) {
      const meta = zip.getEntry("pack.mcmeta");
      if (meta) Object.assign(base, parseMcmeta(meta.getData()));
      else base.missingMeta = true;   // often a zip-inside-a-folder mistake
    }
    const png = zip.getEntry("pack.png");
    if (png) base.icon = iconDataURI(png.getData());
  } catch {
    if (withMeta) base.malformed = true;  // unreadable archive: still listed by name
  }
  return base;
}

// Every pack (zip or folder) in a folder, name-sorted. Missing folder → [].
function listDir(dir, withMeta) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const info = packInfo(dir, name, withMeta);
    if (info) out.push(info);
  }
  return out.sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { sensitivity: "base" }));
}

// ---- Resource packs ----
// options.txt `resourcePacks` is a JSON array in application order: later entries
// win (highest in-game priority). File packs appear as "file/<name>"; built-in and
// mod-provided entries ("vanilla", "fabric", …) are preserved, never managed.
function fileEntryNames(enabled) {
  const out = [];
  for (const e of enabled) if (typeof e === "string" && e.startsWith("file/")) out.push(e.slice(5));
  return out;
}
function readEnabledResourcePacks(doc) {
  if (!doc.exists) return [];
  const raw = getOption(doc, "resourcePacks");
  if (!raw) return [];
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

function listResourcePacks(dataDir, instanceId) {
  const dir = packsFolder(dataDir, instanceId, "resourcepack");
  const doc = readOptions(instanceDir(dataDir, instanceId));
  const enabled = readEnabledResourcePacks(doc);
  const enabledFiles = fileEntryNames(enabled);
  const packs = listDir(dir, true).map((p) => ({
    ...p,
    enabled: enabledFiles.includes(p.fileName),
  }));
  return { hasOptions: doc.exists, packs, enabledOrder: enabledFiles };
}

// Enable or disable one pack. Enabling appends "file/<name>" at the end of the
// array (top in-game priority). With no options.txt yet, enabling creates a
// minimal one — the game reads it on first launch and fills in its defaults.
function setResourcePackEnabled(dataDir, instanceId, fileName, enabled) {
  const name = safeName(fileName);
  const dir = packsFolder(dataDir, instanceId, "resourcepack");
  if (!fs.existsSync(path.join(dir, name))) throw new Error(`Pack "${name}" not found.`);
  const doc = readOptions(instanceDir(dataDir, instanceId));
  let list = readEnabledResourcePacks(doc);
  if (!doc.exists && !list.length) list = ["vanilla"];
  list = list.filter((e) => e !== "file/" + name && e !== name);
  if (enabled) list.push("file/" + name);
  setOption(doc, "resourcePacks", JSON.stringify(list));
  writeLineFile(doc);
  return listResourcePacks(dataDir, instanceId);
}

// Reorder the enabled file packs. `order` is every enabled pack's file name in
// options-array order (last = highest in-game priority). Non-file entries keep
// their positions at the front, untouched.
function reorderResourcePacks(dataDir, instanceId, order) {
  if (!Array.isArray(order)) throw new Error("Order must be a list of pack file names.");
  const doc = readOptions(instanceDir(dataDir, instanceId));
  if (!doc.exists) throw new Error("This instance has no options.txt yet — launch it once first.");
  const current = readEnabledResourcePacks(doc);
  const currentFiles = fileEntryNames(current);
  const next = order.map((n) => safeName(n));
  if (next.length !== currentFiles.length || next.some((n) => !currentFiles.includes(n))) {
    throw new Error("Reorder list doesn't match the enabled packs.");
  }
  const merged = current.filter((e) => !(typeof e === "string" && e.startsWith("file/")))
    .concat(next.map((n) => "file/" + n));
  setOption(doc, "resourcePacks", JSON.stringify(merged));
  writeLineFile(doc);
  return listResourcePacks(dataDir, instanceId);
}

// ---- Shader packs ----
// The active shader lives in the Iris (Fabric/Quilt) or Oculus (Forge/NeoForge)
// config. Neither installed → canSelect:false and the list is manage-only.
function shaderConfig(dataDir, instanceId) {
  const cfgDir = path.join(instanceDir(dataDir, instanceId), "config");
  for (const name of ["iris.properties", "oculus.properties"]) {
    const file = path.join(cfgDir, name);
    if (fs.existsSync(file)) return { file, name };
  }
  return null;
}

function listShaderPacks(dataDir, instanceId) {
  const dir = packsFolder(dataDir, instanceId, "shader");
  const cfg = shaderConfig(dataDir, instanceId);
  let selected = null;
  let shadersOn = false;
  if (cfg) {
    const doc = readLineFile(cfg.file);
    selected = getProp(doc, "shaderPack") || null;
    const en = getProp(doc, "enableShaders");
    shadersOn = en == null ? !!selected : en === "true";
  }
  return {
    packs: listDir(dir, false),
    configFile: cfg ? cfg.name : null,
    canSelect: !!cfg,
    selected, shadersOn,
  };
}

// Activate a shader pack (fileName) or turn shaders off (fileName == null).
function selectShaderPack(dataDir, instanceId, fileName) {
  const cfg = shaderConfig(dataDir, instanceId);
  if (!cfg) throw new Error("No Iris or Oculus config found — install a shader loader mod, launch once, then pick a shader here.");
  const doc = readLineFile(cfg.file);
  if (fileName == null || fileName === "") {
    setProp(doc, "enableShaders", "false");
  } else {
    const name = safeName(fileName);
    const dir = packsFolder(dataDir, instanceId, "shader");
    if (!fs.existsSync(path.join(dir, name))) throw new Error(`Shader pack "${name}" not found.`);
    setProp(doc, "shaderPack", name);
    setProp(doc, "enableShaders", "true");
  }
  writeLineFile(doc);
  return listShaderPacks(dataDir, instanceId);
}

// ---- Datapacks (per world) ----
function listDatapacks(dataDir, instanceId, world) {
  const dir = packsFolder(dataDir, instanceId, "datapack", world);
  return { packs: listDir(dir, true) };
}

// ---- Shared: delete / import ----
function deletePack(dataDir, instanceId, kind, fileName, world) {
  const name = safeName(fileName);
  const dir = packsFolder(dataDir, instanceId, kind, world);
  const full = path.join(dir, name);
  if (!fs.existsSync(full)) throw new Error(`"${name}" not found.`);
  fs.rmSync(full, { recursive: true, force: true });
  if (kind === "resourcepack") {
    // Also drop it from the enabled list so options.txt never points at a ghost.
    const doc = readOptions(instanceDir(dataDir, instanceId));
    if (doc.exists) {
      const list = readEnabledResourcePacks(doc);
      const next = list.filter((e) => e !== "file/" + name && e !== name);
      if (next.length !== list.length) { setOption(doc, "resourcePacks", JSON.stringify(next)); writeLineFile(doc); }
    }
  }
  return true;
}

// Copy a .zip into the pack folder (collision-safe name). The archive must at
// least open; a missing root pack.mcmeta is flagged, not fatal — the list view
// shows it and the user can fix the zip.
function importPack(dataDir, instanceId, kind, world, filePath) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error("File not found.");
  if (!/\.zip$/i.test(filePath)) throw new Error("Packs import as .zip files.");
  try { new AdmZip(filePath).getEntries(); } catch { throw new Error("That file isn't a readable zip archive."); }
  const dir = packsFolder(dataDir, instanceId, kind, world);
  const base = safeName(path.basename(filePath));
  let dest = path.join(dir, base);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, base.replace(/\.zip$/i, "") + ` (${n}).zip`);
  fs.copyFileSync(filePath, dest);
  const withMeta = kind !== "shader";
  return packInfo(dir, path.basename(dest), withMeta);
}

module.exports = {
  // managers
  listResourcePacks, setResourcePackEnabled, reorderResourcePacks,
  listShaderPacks, selectShaderPack,
  listDatapacks,
  deletePack, importPack, packsFolder,
  // shared line-file helpers (keybinds.js edits options.txt through these)
  instanceDir, safeName, splitLines, joinLines,
  readLineFile, writeLineFile, readOptions, getOption, setOption, removeOptions,
};
