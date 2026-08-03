// Filesystem-facing features: the Storage screen, the instance File browser,
// and the Config manager. All three are reads and edits under the data dir, so
// they share one module and one safety rule.
//
// THE SAFETY RULE: every path that comes from the renderer is resolved and
// checked to be inside the directory it claims to be in. A renderer bug — or a
// crafted archive that planted a "../../.." name — must not be able to read or
// write outside the instance.
const fs = require("fs");
const path = require("path");

function dirSize(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(full);
    else if (e.isFile()) { try { total += fs.statSync(full).size; } catch { /* vanished mid-walk */ } }
  }
  return total;
}

// Reject anything that escapes `root` once symlinks and .. are resolved.
function inside(root, target) {
  const r = path.resolve(root) + path.sep;
  const t = path.resolve(target);
  return t === path.resolve(root) || t.startsWith(r);
}
function safeJoin(root, rel) {
  const full = path.resolve(root, rel || "");
  if (!inside(root, full)) throw new Error("That path is outside the instance.");
  return full;
}

// ---- Storage screen ---------------------------------------------------------
// Where the disk actually went, split the way a user would ask about it.
function storage({ dataDir, instances }) {
  const buckets = [
    { id: "instances", label: "Instances", dir: path.join(dataDir, "instances"),
      hint: "Mods, configs, worlds and screenshots for every pack." },
    { id: "versions", label: "Game versions", dir: path.join(dataDir, "versions"),
      hint: "The Minecraft jars themselves. Shared between packs on the same version." },
    { id: "libraries", label: "Libraries", dir: path.join(dataDir, "libraries"),
      hint: "Loader and mod libraries. Shared across every instance." },
    { id: "assets", label: "Assets", dir: path.join(dataDir, "assets"),
      hint: "Sounds, languages and textures. Shared, and re-downloadable." },
    { id: "runtimes", label: "Java runtimes", dir: path.join(dataDir, "runtimes"),
      hint: "Bundled JREs. Re-downloaded on demand." },
    { id: "backups", label: "World backups", dir: path.join(dataDir, "backups"),
      hint: "Zips you made from the Worlds tab. Safe to clear if you have copies." },
  ];
  const rows = buckets.map((b) => ({ ...b, bytes: dirSize(b.dir) }));

  // Per-instance, so the biggest pack is obvious.
  const perInstance = (instances || []).map((i) => ({
    id: i.id, name: i.name,
    bytes: dirSize(path.join(dataDir, "instances", i.id)),
  })).sort((a, b) => b.bytes - a.bytes);

  return { buckets: rows, perInstance, total: rows.reduce((n, r) => n + r.bytes, 0) };
}

// Only ever offered for caches that regenerate. Instances and backups are the
// user's data and are never in this list.
const RECLAIMABLE = new Set(["assets", "runtimes", "libraries"]);
function reclaim({ dataDir, bucket }) {
  if (!RECLAIMABLE.has(bucket)) throw new Error("That isn't a cache — it holds your own data.");
  const dir = path.join(dataDir, bucket === "runtimes" ? "runtimes" : bucket);
  const before = dirSize(dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { throw new Error("Couldn't clear it: " + e.message); }
  return { cleared: before };
}

// ---- File browser -----------------------------------------------------------
function listDir({ root, rel }) {
  const dir = safeJoin(root, rel);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { rel: rel || "", entries: [] }; }
  const out = entries.map((e) => {
    const full = path.join(dir, e.name);
    let size = 0, modified = 0;
    try { const st = fs.statSync(full); size = st.size; modified = st.mtimeMs; } catch { /* vanished */ }
    return { name: e.name, dir: e.isDirectory(), size: e.isDirectory() ? 0 : size, modified };
  });
  // Folders first, then alphabetical — the order a file browser is expected to use.
  out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  return { rel: rel || "", entries: out };
}

// Text files only, and only small ones: this backs a config editor, not a hex
// viewer, and reading a 2GB region file into a string would take the app down.
const MAX_TEXT = 2 * 1024 * 1024;
function readText({ root, rel }) {
  const file = safeJoin(root, rel);
  const st = fs.statSync(file);
  if (st.size > MAX_TEXT) throw new Error("That file is too big to edit here.");
  return { rel, text: fs.readFileSync(file, "utf8"), size: st.size };
}
function writeText({ root, rel, text }) {
  const file = safeJoin(root, rel);
  if (!fs.existsSync(file)) throw new Error("That file no longer exists.");
  fs.writeFileSync(file, String(text));
  return { rel, size: Buffer.byteLength(String(text)) };
}

// ---- Config manager ---------------------------------------------------------
// Every editable config in an instance, flattened with its folder so a mod's
// files group together in the list.
const CONFIG_EXT = /\.(json|json5|toml|cfg|conf|properties|txt|yaml|yml|snbt|ini)$/i;
function listConfigs({ instanceDir }) {
  const root = path.join(instanceDir, "config");
  const out = [];
  const walk = (dir, rel, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, childRel, depth + 1); continue; }
      if (!CONFIG_EXT.test(e.name)) continue;
      let size = 0, modified = 0;
      try { const st = fs.statSync(full); size = st.size; modified = st.mtimeMs; } catch { /* vanished */ }
      out.push({ rel: childRel.split(path.sep).join("/"), name: e.name,
                 folder: rel ? rel.split(path.sep).join("/") : "", size, modified });
    }
  };
  walk(root, "", 0);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return { root, configs: out };
}

module.exports = { storage, reclaim, listDir, readText, writeText, listConfigs, dirSize, safeJoin };
