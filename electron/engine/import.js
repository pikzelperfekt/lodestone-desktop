// .mrpack import: installs a Modrinth modpack into a fresh instance. A .mrpack is a
// zip whose `modrinth.index.json` declares the game + loader and lists every managed
// file (sha1-verified, with one or more mirror URLs), plus `overrides/` (and optional
// `client-overrides/`) trees that are copied verbatim into the instance directory.
// Mirrors LodestoneCore's ModpackImporter. Instance creation is delegated back to the
// engine's own createInstance so the instance shape stays in one place.
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const { download, pool } = require("./net");
const { paths } = require("./install");

// modrinth.index.json dependencies.<key> → our loader id, in resolution order.
// Absence of any modloader dependency means a vanilla instance.
const LOADER_KEYS = [
  ["fabric-loader", "fabric"],
  ["quilt-loader", "quilt"],
  ["neoforge", "neoforge"],
  ["forge", "forge"],
];

function pickLoader(deps) {
  const d = deps || {};
  for (const [key, loader] of LOADER_KEYS) if (d[key]) return loader;
  return "vanilla";
}

// A managed file is client-installable unless its client env is explicitly "unsupported".
function clientWanted(file) {
  return !(file && file.env && file.env.client === "unsupported");
}

// Resolve `rel` against `baseDir`, refusing anything that escapes the instance directory
// (a malicious modpack could otherwise write outside the sandbox via ".." or absolute paths).
function safeJoin(baseDir, rel) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Unsafe path in modpack: ${rel}`);
  }
  return target;
}

// Best-effort content record for the instance list, derived from a managed file's path.
// The top-level folder tells us the kind; the filename is enough to show it in the UI.
function contentRecordFor(file) {
  const rel = String(file.path).replace(/\\/g, "/");
  const fileName = path.posix.basename(rel);
  const top = rel.split("/")[0];
  const kind = top === "resourcepacks" ? "resourcepack" : top === "shaderpacks" ? "shader" : "mod";
  return {
    projectId: null,
    versionId: null,
    title: fileName.replace(/\.(jar|zip)$/i, ""),
    fileName,
    kind,
    iconURL: null,
    size: file.fileSize || 0,
    versionNumber: "",
    requiredBy: null,
  };
}

// Download to `dest`, trying each mirror URL in turn until one succeeds. sha1-verified.
async function downloadFirst(urls, dest, sha1) {
  let lastErr = null;
  for (const url of urls || []) {
    try { await download(url, dest, sha1); return url; }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error(`No working download URL for ${path.basename(dest)}`);
}

// Copy an `overrides/`-style tree from the zip into the instance dir. Returns the number
// of files written. `client-overrides/` is applied after `overrides/` so it wins on conflict.
function extractOverrides(zip, prefix, instanceDir) {
  let written = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, "/");
    if (!name.startsWith(prefix + "/")) continue;
    const rel = name.slice(prefix.length + 1);
    if (!rel) continue;
    const dest = safeJoin(instanceDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
    written++;
  }
  return written;
}

// Import a .mrpack. `createInstance` and `persist` are injected by index.js so the
// instance shape + store live in one place. Returns the created (and populated) instance.
async function importModpack({ dataDir, filePath, createInstance, persist, onLog }) {
  const log = (m) => { try { onLog && onLog(m); } catch {} };
  if (!filePath || !fs.existsSync(filePath)) throw new Error("Modpack file not found.");

  const zip = new AdmZip(filePath);
  const indexEntry = zip.getEntry("modrinth.index.json");
  if (!indexEntry) throw new Error("Not a Modrinth modpack: modrinth.index.json is missing.");

  let index;
  try { index = JSON.parse(indexEntry.getData().toString("utf8")); }
  catch { throw new Error("Modpack index (modrinth.index.json) is not valid JSON."); }

  const deps = index.dependencies || {};
  const mcVersion = deps.minecraft;
  if (!mcVersion) throw new Error("Modpack does not declare a Minecraft version.");
  const loader = pickLoader(deps);
  const name = (index.name && String(index.name).trim()) || path.basename(filePath).replace(/\.mrpack$/i, "");

  log(`Importing “${name}” (${loader === "vanilla" ? "Vanilla" : loader} ${mcVersion})…`);

  // 1) Create the instance via the engine's own factory (real shape + persistence + mkdir).
  const instance = createInstance({ name, mcVersion, loader });
  const instanceDir = paths(dataDir).instanceDir(instance.id);
  fs.mkdirSync(instanceDir, { recursive: true });

  // 2) Download every client-supported managed file into the instance, sha1-verified,
  //    using the first mirror URL that works.
  const files = (Array.isArray(index.files) ? index.files : []).filter(clientWanted);
  const records = [];
  log(`Downloading ${files.length} file${files.length === 1 ? "" : "s"}…`);
  await pool(files, 8, async (file) => {
    if (!file || !file.path) return;
    const dest = safeJoin(instanceDir, String(file.path).replace(/\\/g, "/"));
    const sha1 = file.hashes && file.hashes.sha1;
    await downloadFirst(file.downloads, dest, sha1);
    records.push(contentRecordFor(file));
  }, (done, total) => log(`Downloaded ${done}/${total} files.`));

  // 3) Copy the overrides trees verbatim. `overrides/` first, then `client-overrides/`
  //    (client wins on conflict), matching the Modrinth spec.
  const overrideCount = extractOverrides(zip, "overrides", instanceDir)
    + extractOverrides(zip, "client-overrides", instanceDir);
  if (overrideCount) log(`Applied ${overrideCount} override file${overrideCount === 1 ? "" : "s"}.`);

  // 4) Populate the instance content list (best-effort) and persist.
  instance.content = records;
  instance.mods = records.filter((c) => c.kind === "mod").length;
  persist(instance);

  log(`Imported “${instance.name}”: ${records.length} file${records.length === 1 ? "" : "s"}, ${overrideCount} override${overrideCount === 1 ? "" : "s"}.`);
  return instance;
}

module.exports = { importModpack, pickLoader, clientWanted, contentRecordFor };
