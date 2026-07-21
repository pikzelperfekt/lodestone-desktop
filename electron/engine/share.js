// Share & sync a pack. Turns an instance's Modrinth-sourced mod list into a compact,
// pasteable "share code" (base64url JSON) and into a real Modrinth .mrpack file, and
// syncs an instance's mods to match a shared definition (install missing, update
// changed, remove extras). This is the offline-capable half of the Mac app's "send a
// pack to a friend / keep a shared pack in sync": a code or file moves the pack between
// machines; true live cross-machine auto-sync waits on the accounts backend.
const path = require("path");
const AdmZip = require("adm-zip");
const content = require("./content");
const loaders = require("./loaders");
const { paths } = require("./install");

// Modrinth project_type / our `kind` → the instance subfolder its file belongs in.
const FOLDER = { mod: "mods", resourcepack: "resourcepacks", shader: "shaderpacks" };
// Our loader id → the modrinth.index.json dependencies key. Vanilla has no loader key.
const LOADER_DEP_KEY = { fabric: "fabric-loader", quilt: "quilt-loader", neoforge: "neoforge", forge: "forge" };

// A Modrinth id is base62 (letters + digits). CurseForge records are prefixed "cf:" (or
// carry a purely-numeric project id), and modpack-imported files have no id at all — none
// of those can be re-resolved from a Modrinth code, so we skip them when sharing.
function isModrinthId(id) {
  return typeof id === "string" && id.length > 0 && !id.startsWith("cf:") && !/^\d+$/.test(id);
}

function primaryFile(v) {
  const files = (v && v.files) || [];
  return files.find((f) => f.primary) || files[0] || null;
}

// A compact, shareable definition of an instance's pack: just enough to re-resolve every
// Modrinth mod on another machine. Keys are terse (`p`/`v`/`k`) to keep the code short.
function packDef(instance) {
  const items = Array.isArray(instance && instance.content) ? instance.content : [];
  const mods = items
    .filter((c) => c && isModrinthId(c.projectId))
    .map((c) => {
      const m = { p: String(c.projectId), k: c.kind || "mod" };
      if (isModrinthId(c.versionId)) m.v = String(c.versionId); // pin the exact version when we know it
      return m;
    });
  return {
    name: (instance && instance.name) || "Shared pack",
    loader: (instance && instance.loader) || "vanilla",
    mcVersion: (instance && instance.mcVersion) || "",
    mods,
  };
}

// A share code is the base64url of the definition JSON — short enough to paste in a chat.
function encodeCode(def) {
  return Buffer.from(JSON.stringify(def), "utf8").toString("base64url");
}

// Decode a pasted code back into a definition, tolerant of surrounding whitespace/newlines,
// and guarded so a bad paste fails with a friendly message instead of a raw parse error.
function decodeCode(code) {
  if (!code || typeof code !== "string") throw new Error("Paste a share code first.");
  const raw = code.trim().replace(/\s+/g, "");
  if (!raw) throw new Error("Paste a share code first.");
  let def;
  try {
    def = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Error("That share code isn't valid. Copy the whole code and try again.");
  }
  if (!def || typeof def !== "object" || !Array.isArray(def.mods) || !def.mcVersion) {
    throw new Error("That share code isn't a Lodestone pack.");
  }
  return def;
}

// Run `fn` over `items` with a concurrency cap, collecting results in order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, worker));
  return out;
}

// Write a real Modrinth .mrpack for `instance` to `outPath`. Resolves each Modrinth mod's
// file (sha1/sha512-verified download URL) through the version API and emits a spec-shaped
// modrinth.index.json (formatVersion 1) with the minecraft + loader dependencies. Mods that
// can no longer be resolved (delisted, etc.) are skipped and counted, not fatal.
async function exportMrpack(dataDir, instance, outPath) {
  if (!outPath) throw new Error("No output path for the modpack.");
  const def = packDef(instance);

  const resolved = await mapLimit(def.mods, 6, async (m) => {
    try {
      const v = m.v ? await content.version(m.v)
                    : await content.bestVersion(m.p, m.k, { loader: def.loader, mc: def.mcVersion });
      const file = primaryFile(v);
      if (!file || !file.url || !file.filename) return null;
      const folder = FOLDER[m.k] || "mods";
      const hashes = {};
      if (file.hashes && file.hashes.sha1) hashes.sha1 = file.hashes.sha1;
      if (file.hashes && file.hashes.sha512) hashes.sha512 = file.hashes.sha512;
      return {
        path: `${folder}/${file.filename}`,
        hashes,
        env: { client: "required", server: "required" },
        downloads: [file.url],
        fileSize: file.size || 0,
      };
    } catch { return null; }
  });

  const files = resolved.filter(Boolean);
  const skipped = resolved.length - files.length;

  const dependencies = { minecraft: def.mcVersion };
  const loaderKey = LOADER_DEP_KEY[def.loader];
  if (loaderKey) {
    // A real .mrpack pins a loader build; resolve the newest for this Minecraft version.
    dependencies[loaderKey] = await loaders.latestLoaderVersion(def.loader, def.mcVersion);
  }

  const index = {
    formatVersion: 1,
    game: "minecraft",
    versionId: "1.0.0",
    name: def.name,
    dependencies,
    files,
  };

  const zip = new AdmZip();
  zip.addFile("modrinth.index.json", Buffer.from(JSON.stringify(index, null, 2), "utf8"));
  zip.writeZip(outPath);

  return { path: outPath, name: def.name, files: files.length, skipped };
}

// Make `instance` match `def`: install anything in def not present, re-install a mod whose
// pinned version differs, and remove Modrinth mods the instance has that def doesn't. Mutates
// `instance.content` (+ `instance.mods`) in memory; persistence is the caller's job. Returns
// { added, removed, unchanged } as arrays of content records.
async function syncInstance({ dataDir, instance, def, onLog }) {
  const log = (m) => { try { onLog && onLog(m); } catch {} };
  instance.content = Array.isArray(instance.content) ? instance.content : [];

  const want = Array.isArray(def && def.mods) ? def.mods.filter((m) => m && m.p) : [];
  const wantByProject = new Map(want.map((m) => [String(m.p), m]));

  const added = [], unchanged = [];
  const keep = new Set(); // project ids installed this run (incl. dependencies) — never removed below

  // 1) Install missing mods and update pinned mods whose version has changed.
  for (const m of want) {
    const pid = String(m.p);
    keep.add(pid);
    const current = instance.content.find((c) => c.projectId === pid);
    const pinned = isModrinthId(m.v) ? String(m.v) : null;

    if (current && (!pinned || current.versionId === pinned)) { unchanged.push(current); continue; }

    if (current) {
      log(`Updating ${current.title}...`);
      try { content.remove({ dataDir, instance, fileName: current.fileName, kind: current.kind }); } catch {}
    }
    const records = await content.install({ dataDir, instance, projectId: pid, versionId: pinned, onLog: log });
    for (const r of records) {
      keep.add(String(r.projectId)); // protect dependencies pulled in alongside this mod
      const idx = instance.content.findIndex((c) => c.projectId === r.projectId);
      if (idx >= 0) instance.content[idx] = r; else instance.content.push(r);
    }
    const primary = records.find((r) => r.projectId === pid) || records[0];
    if (primary) added.push(primary);
  }

  // 2) Remove the instance's own Modrinth mods that the shared pack doesn't include.
  //    Local / CurseForge / freshly-pulled dependency records are left untouched.
  const extras = instance.content.filter(
    (c) => isModrinthId(c.projectId) && !wantByProject.has(String(c.projectId)) && !keep.has(String(c.projectId))
  );
  for (const c of extras) {
    try { content.remove({ dataDir, instance, fileName: c.fileName, kind: c.kind }); } catch {}
    log(`Removed ${c.title}.`);
  }
  const extraIds = new Set(extras.map((c) => c.projectId));
  instance.content = instance.content.filter((c) => !extraIds.has(c.projectId));

  instance.mods = instance.content.filter((c) => c.kind === "mod").length;
  return { added, removed: extras, unchanged };
}

// Create a brand-new instance from a shared definition, then sync its mods to match.
// `createInstance` + `persist` are injected by index.js so the instance shape + store stay
// in one place (same pattern as the .mrpack importer). Returns { instance, summary }.
async function createFromDef({ dataDir, def, createInstance, persist, onLog }) {
  if (!def || !Array.isArray(def.mods)) throw new Error("That share code isn't a Lodestone pack.");
  const instance = createInstance({ name: def.name, mcVersion: def.mcVersion, loader: def.loader });
  const summary = await syncInstance({ dataDir, instance, def, onLog });
  instance.mods = (instance.content || []).filter((c) => c.kind === "mod").length;
  if (persist) persist(instance);
  return { instance, summary };
}

module.exports = {
  packDef, encodeCode, decodeCode, exportMrpack, syncInstance, createFromDef, isModrinthId,
};
