// Lodestone's own pack format (.lodepack). Ground truth is the Mac app's
// Sources/LodestoneCore/Share/Lodepack.swift (v2) + ShareService.swift (v1):
//
//   v2 — a zip container with a `lodepack.json` manifest that carries the WHOLE
//        setup: Modrinth mods linked by URL+sha1 (downloaded on import), the real
//        jars for CurseForge/custom mods (`source: "bundled"`, stored in the zip),
//        plus the instance's `config/` tree, `options.txt` keybinds, icon, and RAM.
//   v1 — an older plain-JSON SharePack file ({name, loader, mcVersion, content:
//        [{projectID, versionID, title, kind}]}); Modrinth-only, no payload.
//
// This module mirrors LodepackImporter/LodepackExporter so packs round-trip with
// the Mac app: same manifest keys (Swift Codable — `projectID`/`versionID` casing,
// `source` strictly "modrinth"|"bundled", ISO-8601 `createdAt`), same `local:` /
// `cf:` project-id conventions for non-Modrinth content.
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const { getJSON, download } = require("./net");
const { paths } = require("./install");
const { safeJoin } = require("./import");
const content = require("./content");
const loaders = require("./loaders");

const MANIFEST_NAME = "lodepack.json";
const FORMAT = 2;
const FOLDER = { mod: "mods", resourcepack: "resourcepacks", shader: "shaderpacks" };
const KNOWN_LOADERS = ["vanilla", "fabric", "quilt", "neoforge", "forge"];
const UA = { "User-Agent": "Lodestone/0.2 (windows build)" };

// Mac rule (ModpackExporter.isModrinthSourced) + this app's numeric-CurseForge rule:
// anything local:/cf:/cf-web:-prefixed, purely numeric, or absent is NOT re-resolvable
// from Modrinth and must travel as a bundled file.
function isModrinthSourced(projectId) {
  const id = projectId == null ? "" : String(projectId);
  if (!id) return false;
  if (/^(local:|cf:|cf-web:)/.test(id)) return false;
  if (/^\d+$/.test(id)) return false;
  return true;
}

// Zip entry lookup tolerant of a leading "./" (zip CLIs differ on storing it).
function normalizeEntryName(name) {
  return String(name).replace(/\\/g, "/").replace(/^\.\//, "");
}
function findEntry(zip, rel) {
  const want = normalizeEntryName(rel);
  const direct = zip.getEntry(want);
  if (direct) return direct;
  return zip.getEntries().find((e) => !e.isDirectory && normalizeEntryName(e.entryName) === want) || null;
}

// ---- Detection ----
// "lodepack2" (zip container with lodepack.json) | "lodepack1" (JSON SharePack) | null.
// A .lodepack-named file that is neither fails loudly at import, not here.
function detect(filePath) {
  let head = Buffer.alloc(0);
  try {
    const fd = fs.openSync(filePath, "r");
    head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
  } catch { return null; }
  if (head[0] === 0x50 && head[1] === 0x4b) { // "PK" — LodepackManifest.isContainer
    try { return findEntry(new AdmZip(filePath), MANIFEST_NAME) ? "lodepack2" : null; }
    catch { return null; }
  }
  try {
    const v1 = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (v1 && typeof v1 === "object" && v1.mcVersion && Array.isArray(v1.content)) return "lodepack1";
  } catch {}
  return null;
}

// ---- v1 (JSON SharePack) → share.js definition ----
// Maps the old format onto share.createFromDef's {name, loader, mcVersion, mods:[{p,v,k}]}
// shape so the existing Modrinth install path rebuilds it. Non-Modrinth (local:/cf:) items
// have no payload in v1, so they're counted and skipped, not silently dropped.
function readV1(filePath) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { throw new Error("This .lodepack isn't readable — not a zip container and not valid JSON."); }
  if (!raw || typeof raw !== "object" || !raw.mcVersion || !Array.isArray(raw.content)) {
    throw new Error("This doesn't look like a Lodestone pack (.lodepack).");
  }
  const items = raw.content.filter((c) => c && c.projectID);
  const mods = items.filter((c) => isModrinthSourced(c.projectID))
    .map((c) => ({ p: String(c.projectID), v: c.versionID ? String(c.versionID) : undefined, k: c.kind || "mod" }));
  return {
    name: (raw.name && String(raw.name).trim()) || path.basename(filePath).replace(/\.lodepack$/i, ""),
    loader: KNOWN_LOADERS.includes(raw.loader) ? raw.loader : "vanilla",
    mcVersion: String(raw.mcVersion),
    mods,
    skippedLocal: items.length - mods.length,
  };
}

// Download every linked item with a concurrency cap, collecting failures instead of
// swallowing them (mirrors the Mac Downloader.batchTolerant contract).
async function downloadTolerant(items, limit, onProgress) {
  const failures = [];
  let done = 0;
  const queue = items.slice();
  async function worker() {
    while (queue.length) {
      const it = queue.shift();
      try { await download(it.url, it.dest, it.sha1); }
      catch (e) { failures.push({ item: it, error: e }); }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, worker));
  return failures;
}

// Best-effort title/icon enrichment from the Modrinth projects API (the Mac importer
// does the same); a network failure leaves the manifest-supplied titles in place.
async function enrich(records) {
  const ids = [...new Set(records.filter((r) => r.projectId && isModrinthSourced(r.projectId)).map((r) => String(r.projectId)))];
  if (!ids.length) return records;
  try {
    const projects = await getJSON(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`, UA);
    const byId = new Map();
    for (const p of projects || []) { byId.set(p.id, p); if (p.slug) byId.set(p.slug, p); }
    for (const r of records) {
      const p = byId.get(String(r.projectId));
      if (p) { r.title = p.title || r.title; r.iconURL = p.icon_url || r.iconURL; }
    }
  } catch {}
  return records;
}

// ---- Import (v2 container) ----
// Validates the archive BEFORE creating anything; on any failure after the instance
// exists, `discard` removes it so a broken pack never leaves a half-created instance.
// Returns the persisted instance plus a non-persisted `importSummary`.
async function importLodepack({ dataDir, filePath, createInstance, persist, discard, onLog }) {
  const log = (m) => { try { onLog && onLog(m); } catch {} };
  if (!filePath || !fs.existsSync(filePath)) throw new Error("Pack file not found.");

  let zip;
  try { zip = new AdmZip(filePath); }
  catch { throw new Error("That file isn't a readable .lodepack archive."); }

  const manifestEntry = findEntry(zip, MANIFEST_NAME);
  if (!manifestEntry) throw new Error("This doesn't look like a Lodestone pack (.lodepack) — lodepack.json is missing.");

  let manifest;
  try { manifest = JSON.parse(manifestEntry.getData().toString("utf8")); }
  catch { throw new Error("The pack's manifest (lodepack.json) is not valid JSON."); }

  const format = Number(manifest.format);
  if (Number.isFinite(format) && format > FORMAT) {
    throw new Error(`This .lodepack (format ${format}) was made by a newer Lodestone — update this app to import it.`);
  }
  const mcVersion = manifest.minecraft && String(manifest.minecraft).trim();
  if (!mcVersion) throw new Error("The pack doesn't specify a Minecraft version.");
  const loader = KNOWN_LOADERS.includes(manifest.loader) ? manifest.loader : "vanilla";
  const name = (manifest.name && String(manifest.name).trim()) || path.basename(filePath).replace(/\.lodepack$/i, "");

  log(`Importing “${name}” (${loader === "vanilla" ? "Vanilla" : loader} ${mcVersion})…`);

  // Everything below mutates disk state, so it cleans up after itself on failure.
  const instance = createInstance({ name, mcVersion, loader });
  try {
    const instanceDir = paths(dataDir).instanceDir(instance.id);
    fs.mkdirSync(instanceDir, { recursive: true });

    // The creator's RAM choice rides along (Swift: manifest.ramMB).
    const ram = Number(manifest.ramMB);
    if (Number.isFinite(ram) && ram > 0) instance.ramMB = Math.round(ram);

    // Icon first so the card looks right immediately (mirrors the Mac importer).
    if (manifest.icon) {
      const iconName = path.posix.basename(normalizeEntryName(manifest.icon));
      const iconEntry = findEntry(zip, manifest.icon) || findEntry(zip, iconName);
      if (iconEntry) {
        const dest = safeJoin(instanceDir, iconName);
        fs.writeFileSync(dest, iconEntry.getData());
        instance.icon = iconName;
        instance.iconPath = dest;
        instance.iconVersion = Date.now();
      }
    }

    // Content: linked Modrinth items download by URL (sha1-verified); bundled items
    // (CurseForge / dropped jars) copy straight out of the zip.
    const records = [];
    const pairs = [];   // { url, dest, sha1, record }
    let bundled = 0;
    for (const item of Array.isArray(manifest.content) ? manifest.content : []) {
      if (!item || !item.fileName) continue;
      const kind = FOLDER[item.kind] ? item.kind : "mod";
      const fileName = path.posix.basename(normalizeEntryName(item.fileName));
      const dest = safeJoin(instanceDir, `${FOLDER[kind]}/${fileName}`);
      const record = {
        projectId: item.projectID != null ? String(item.projectID) : null,
        versionId: item.versionID != null && item.versionID !== "" ? String(item.versionID) : null,
        title: item.title || fileName.replace(/\.(jar|zip)$/i, ""),
        fileName, kind, iconURL: null, size: item.fileSize || 0, versionNumber: "", requiredBy: null,
      };
      if (item.source === "modrinth") {
        if (!item.url) continue;
        pairs.push({ url: item.url, dest, sha1: item.sha1 || null, record });
      } else if (item.source === "bundled") {
        const entry = findEntry(zip, item.path || `${FOLDER[kind]}/${fileName}`);
        if (!entry) { log(`Skipping ${record.title} — its file is missing from the pack.`); continue; }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, entry.getData());
        record.size = record.size || entry.header.size || 0;
        records.push(record);
        bundled++;
        log(`Unpacked ${record.title}`);
      }
    }

    if (pairs.length) log(`Downloading ${pairs.length} linked mod${pairs.length === 1 ? "" : "s"}…`);
    const failures = await downloadTolerant(pairs, 8, (done, total) => log(`Downloaded ${done}/${total} linked files.`));
    if (pairs.length && failures.length === pairs.length) {
      throw new Error("Couldn't download any of the pack's mods — check your connection and try again.");
    }
    const failedDests = new Set(failures.map((f) => f.item.dest));
    for (const p of pairs) if (!failedDests.has(p.dest)) records.push(p.record);
    for (const f of failures) log(`Couldn't download ${f.item.record.title}: ${f.error.message}`);

    // The creator's configs + keybinds/video settings.
    let includedConfigs = false, includedKeybinds = false;
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const rel = normalizeEntryName(entry.entryName);
      if (!rel.startsWith("config/")) continue;
      const dest = safeJoin(instanceDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.getData());
      includedConfigs = true;
    }
    const options = findEntry(zip, "options.txt");
    if (options) {
      fs.writeFileSync(path.join(instanceDir, "options.txt"), options.getData());
      includedKeybinds = true;
    }
    if (includedConfigs) log("Applied the creator's configs.");
    if (includedKeybinds) log("Applied the creator's keybinds + video settings.");

    instance.content = await enrich(records);
    instance.mods = records.filter((r) => r.kind === "mod").length;
    persist(instance);

    log(`Imported “${instance.name}”: ${pairs.length - failures.length} linked, ${bundled} bundled.`);
    return {
      ...instance,
      importSummary: {
        format: 2,
        linked: pairs.length - failures.length,
        bundled,
        failedDownloads: failures.map((f) => f.item.record.fileName),
        includedConfigs, includedKeybinds,
      },
    };
  } catch (e) {
    try { discard && discard(instance.id); } catch {}
    throw e;
  }
}

// ---- Export (v2 container) ----
// Modrinth-sourced content links by URL+sha1 (resolved live through the version API,
// like the Mac exporter); everything else bundles its actual file. Configs, keybinds,
// icon, and RAM ride along. The manifest matches LodepackManifest's Codable shape
// exactly so the Mac app imports it as-is.
async function exportLodepack({ dataDir, instance, outPath, author, onLog }) {
  const log = (m) => { try { onLog && onLog(m); } catch {} };
  if (!outPath) throw new Error("No output path for the pack.");
  const instanceDir = paths(dataDir).instanceDir(instance.id);

  const zip = new AdmZip();
  const items = [];
  let linked = 0, bundled = 0, skipped = 0;

  for (const c of Array.isArray(instance.content) ? instance.content : []) {
    if (!c || !c.fileName) continue;
    const kind = FOLDER[c.kind] ? c.kind : "mod";
    const subdir = FOLDER[kind];

    // Linkable Modrinth content → reference by URL + sha1 (downloaded on import).
    if (isModrinthSourced(c.projectId) && c.versionId) {
      try {
        const v = await content.version(c.versionId);
        const files = (v && v.files) || [];
        const file = files.find((f) => f.primary) || files[0];
        if (file && file.url && file.filename) {
          items.push({
            title: c.title || file.filename, kind, source: "modrinth",
            projectID: String(c.projectId), versionID: String(c.versionId),
            fileName: file.filename,
            url: file.url,
            sha1: (file.hashes && file.hashes.sha1) || undefined,
            fileSize: file.size || undefined,
          });
          linked++;
          log(`Linked ${c.title || file.filename}`);
          continue;
        }
      } catch { /* fall through to bundling the local file */ }
    }

    // Bundle the real file (CurseForge / dropped / unresolvable).
    const src = path.join(instanceDir, subdir, c.fileName);
    if (!fs.existsSync(src)) { skipped++; continue; }
    const rel = `${subdir}/${c.fileName}`;
    zip.addFile(rel, fs.readFileSync(src));
    items.push({
      title: c.title || c.fileName, kind, source: "bundled",
      projectID: c.projectId != null ? String(c.projectId) : `local:${c.fileName}`,
      versionID: c.versionId != null ? String(c.versionId) : c.fileName,
      fileName: c.fileName, path: rel,
    });
    bundled++;
    log(`Bundled ${c.title || c.fileName}`);
  }

  // The creator's setup: configs + keybinds/video settings ride along.
  let includedConfigs = false, includedKeybinds = false;
  const configDir = path.join(instanceDir, "config");
  if (fs.existsSync(configDir) && fs.statSync(configDir).isDirectory()) {
    zip.addLocalFolder(configDir, "config");
    includedConfigs = true;
  }
  const options = path.join(instanceDir, "options.txt");
  if (fs.existsSync(options)) {
    zip.addFile("options.txt", fs.readFileSync(options));
    includedKeybinds = true;
  }

  // Icon, when the instance has one — stored as icon.<ext> at the zip root.
  let iconName;
  if (instance.icon) {
    const src = path.join(instanceDir, path.posix.basename(String(instance.icon)));
    if (fs.existsSync(src)) {
      const ext = path.extname(src).replace(/^\./, "") || "png";
      iconName = `icon.${ext}`;
      zip.addFile(iconName, fs.readFileSync(src));
    }
  }

  // Pin the loader build like the Mac exporter does; tolerate the resolver being
  // offline (loaderVersion is optional in the manifest).
  let loaderVersion;
  if (instance.loader && instance.loader !== "vanilla") {
    try { loaderVersion = await loaders.latestLoaderVersion(instance.loader, instance.mcVersion) || undefined; }
    catch { loaderVersion = undefined; }
  }

  const manifest = {
    format: FORMAT,
    app: "Lodestone",
    name: instance.name,
    author: author || undefined,
    createdAt: new Date().toISOString(),
    icon: iconName,
    minecraft: instance.mcVersion,
    loader: instance.loader || "vanilla",
    loaderVersion,
    ramMB: Number.isFinite(Number(instance.ramMB)) && instance.ramMB > 0 ? Math.round(instance.ramMB) : undefined,
    includesConfigs: includedConfigs,
    includesKeybinds: includedKeybinds,
    content: items,
  };
  zip.addFile(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
  zip.writeZip(outPath);

  log(`Exported ${instance.name}.lodepack: ${linked} linked, ${bundled} bundled${skipped ? `, ${skipped} skipped (file missing)` : ""}.`);
  return { path: outPath, name: instance.name, linked, bundled, skipped, includedConfigs, includedKeybinds };
}

module.exports = { detect, readV1, importLodepack, exportLodepack, isModrinthSourced, MANIFEST_NAME };
