// CurseForge support: search + install mods and import a CurseForge modpack .zip.
// Mirrors LodestoneCore's CurseForge.swift (CurseForgeService + CurseForgeImporter).
// CurseForge's API requires a user-supplied key (console.curseforge.com), sent as the
// `x-api-key` header, so every call here takes a `key` and the caller is responsible
// for prompting the user when it's missing. Normalized search hits match the Modrinth
// hit shape the Discover UI already renders, tagged with source:"curseforge".
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const { download, pool } = require("./net");
const { paths } = require("./install");
const { safeJoin, extractOverrides } = require("./import");

const API = "https://api.curseforge.com/v1";
const GAME_ID = 432;        // Minecraft
const HEADERS = (key) => ({ "x-api-key": key, "Accept": "application/json" });

// CurseForge's modLoaderType code for a loader (0 = unspecified / vanilla).
const LOADER_CODE = { forge: 1, fabric: 4, quilt: 5, neoforge: 6, vanilla: 0 };
function loaderCode(loader) { return LOADER_CODE[loader] != null ? LOADER_CODE[loader] : 0; }

// CurseForge classId per content type (parallels Modrinth project types).
function classId(type) {
  if (type === "modpack") return 4471;
  if (type === "resourcepack") return 12;
  if (type === "shader") return 6552;
  return 6; // mods
}

// A managed-file hash list uses algo 1 for sha1.
function sha1Of(file) {
  const h = (file && file.hashes) || [];
  const found = h.find((x) => x.algo === 1);
  return found ? found.value : null;
}

async function cfGet(pathSeg, params, key) {
  if (!key) throw new Error("A CurseForge API key is required. Add one in Settings.");
  const url = new URL(`${API}/${pathSeg}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { headers: HEADERS(key) });
  if (r.status === 401 || r.status === 403) throw new Error("CurseForge rejected the API key. Check it in Settings.");
  if (!r.ok) throw new Error(`CurseForge ${r.status}`);
  return r.json();
}

async function cfPost(pathSeg, body, key) {
  if (!key) throw new Error("A CurseForge API key is required. Add one in Settings.");
  const r = await fetch(`${API}/${pathSeg}`, {
    method: "POST",
    headers: { ...HEADERS(key), "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (r.status === 401 || r.status === 403) throw new Error("CurseForge rejected the API key. Check it in Settings.");
  if (!r.ok) throw new Error(`CurseForge ${r.status}`);
  return r.json();
}

// Map a raw CurseForge search result into the same hit shape Modrinth produces, so the
// Discover UI renders it with the exact same row. `id` is the numeric CurseForge mod id.
function normalizeHit(m) {
  const authors = Array.isArray(m.authors) ? m.authors : [];
  return {
    id: m.id,
    title: m.name || "",
    author: (authors[0] && authors[0].name) || "",
    description: m.summary || "",
    downloads: m.downloadCount || 0,
    icon: (m.logo && m.logo.url) || null,
    source: "curseforge",
  };
}

// Search CurseForge Minecraft mods, scoped to the instance's loader + MC when supplied.
// Returns normalized (Modrinth-shaped) hits.
async function search({ query, type, loader, mc, key, limit }) {
  const params = {
    gameId: GAME_ID,
    classId: classId(type || "mod"),
    searchFilter: query || "",
    sortField: 2,     // popularity
    sortOrder: "desc",
    pageSize: limit || 30,
  };
  if (mc) params.gameVersion = mc;
  if (loader && loader !== "vanilla") params.modLoaderType = loaderCode(loader);
  const json = await cfGet("mods/search", params, key);
  return (json.data || []).map(normalizeHit);
}

// Look up a single mod's metadata (name / logo / links).
async function mod(modId, key) {
  const json = await cfGet(`mods/${encodeURIComponent(modId)}`, {}, key);
  return json.data;
}

// Files for a mod, newest first, filtered to the instance's MC + loader when supplied.
async function modFiles(modId, { loader, mc }, key) {
  const params = { pageSize: 50 };
  if (mc) params.gameVersion = mc;
  if (loader && loader !== "vanilla") params.modLoaderType = loaderCode(loader);
  const json = await cfGet(`mods/${encodeURIComponent(modId)}/files`, params, key);
  return json.data || [];
}

// Resolve concrete file info (download URLs, hashes) for a list of file ids, chunked.
async function resolveFiles(fileIds, key) {
  const out = [];
  for (let i = 0; i < fileIds.length; i += 200) {
    const chunk = fileIds.slice(i, i + 200);
    const json = await cfPost("mods/files", { fileIds: chunk }, key);
    for (const f of json.data || []) out.push(f);
  }
  return out;
}

// A CurseForge download URL may contain spaces; encode them so fetch accepts it. The URL
// is otherwise already a well-formed edge.forgecdn.net link.
function safeURL(u) {
  if (!u) return u;
  try { return encodeURI(u); } catch { return u; }
}

// Pick the best installable file for the instance: the newest file that carries a real
// download URL. `modFiles` already returns newest-first, filtered to loader + MC.
function pickFile(files) {
  const usable = (files || []).filter((f) => f && f.downloadUrl);
  return usable[0] || null;
}

// Install a single CurseForge mod into `instance.mods/`. Returns the content record
// (matching the Modrinth record shape, tagged source:"curseforge").
async function installMod({ dataDir, instance, modId, key, onLog }) {
  const log = (m) => { try { onLog && onLog(m); } catch {} };
  const scope = { loader: instance.loader, mc: instance.mcVersion };
  let files = await modFiles(modId, scope, key);
  // Relax the MC filter if nothing matched, mirroring content.js's bestVersion fallback.
  if ((!files || !files.length) && instance.mcVersion) files = await modFiles(modId, { loader: instance.loader }, key);
  const file = pickFile(files);
  const meta = await mod(modId, key).catch(() => null);
  const title = (meta && meta.name) || `Mod ${modId}`;
  if (!file) {
    throw new Error(`No ${instance.loader} build of “${title}” for Minecraft ${instance.mcVersion} on CurseForge.`);
  }
  const dest = path.join(paths(dataDir).instanceDir(instance.id), "mods", file.fileName);
  log(`Downloading ${title}…`);
  await download(safeURL(file.downloadUrl), dest, sha1Of(file));
  return {
    projectId: `cf:${modId}`,
    versionId: `cf:${file.id}`,
    title,
    fileName: file.fileName,
    kind: "mod",
    iconURL: (meta && meta.logo && meta.logo.url) || null,
    size: file.fileLength || 0,
    versionNumber: "",
    requiredBy: null,
    source: "curseforge",
  };
}

// modLoaders[].id looks like "fabric-0.15.11" / "forge-47.2.0" → [loader, version].
function loaderFromId(id) {
  const parts = String(id || "").split("-");
  const head = (parts[0] || "").toLowerCase();
  const version = parts.length > 1 ? parts.slice(1).join("-") : null;
  if (head === "fabric") return ["fabric", version];
  if (head === "quilt") return ["quilt", version];
  if (head === "neoforge") return ["neoforge", version];
  if (head === "forge") return ["forge", version];
  return ["vanilla", null];
}

// Derive the instance's loader from a manifest's modLoaders list (primary wins).
function pickLoader(modLoaders) {
  const list = Array.isArray(modLoaders) ? modLoaders : [];
  const ref = list.find((l) => l && l.primary === true) || list[0];
  return loaderFromId(ref && ref.id);
}

// Best-effort content record for a resolved CurseForge file (no metadata lookup).
function recordFor(file) {
  return {
    projectId: `cf:${file.modId}`,
    versionId: `cf:${file.id}`,
    title: String(file.fileName || "").replace(/\.(jar|zip)$/i, ""),
    fileName: file.fileName,
    kind: "mod",
    iconURL: null,
    size: file.fileLength || 0,
    versionNumber: "",
    requiredBy: null,
    source: "curseforge",
  };
}

// Import a CurseForge modpack .zip. Reads `manifest.json` (minecraft.version +
// modLoaders → loader/version, files:[{projectID,fileID}]), resolves every referenced
// file through the CF API, downloads what it can into mods/, and copies the overrides/
// tree verbatim. `createInstance` and `persist` are injected by index.js so the instance
// shape + store live in one place. Returns the populated instance with a manualDownloads
// list (files whose authors disabled API delivery, which can't be fetched automatically).
async function importZip({ dataDir, filePath, key, createInstance, persist, onLog }) {
  const log = (m) => { try { onLog && onLog(m); } catch {} };
  if (!filePath || !fs.existsSync(filePath)) throw new Error("Modpack file not found.");
  if (!key) throw new Error("Importing a CurseForge modpack needs a CurseForge API key. Add one in Settings.");

  const zip = new AdmZip(filePath);
  const manifestEntry = zip.getEntry("manifest.json");
  if (!manifestEntry) throw new Error("Not a CurseForge modpack: manifest.json is missing.");

  let manifest;
  try { manifest = JSON.parse(manifestEntry.getData().toString("utf8")); }
  catch { throw new Error("Modpack manifest (manifest.json) is not valid JSON."); }

  const mc = manifest.minecraft && manifest.minecraft.version;
  if (!mc) throw new Error("Modpack does not declare a Minecraft version.");
  const [loader] = pickLoader(manifest.minecraft && manifest.minecraft.modLoaders);
  const name = (manifest.name && String(manifest.name).trim())
    || path.basename(filePath).replace(/\.zip$/i, "");

  log(`Importing “${name}” (${loader === "vanilla" ? "Vanilla" : loader} ${mc})…`);

  // 1) Create the instance via the engine's own factory (shape + persistence + mkdir).
  const instance = createInstance({ name, mcVersion: mc, loader });
  const instanceDir = paths(dataDir).instanceDir(instance.id);
  const modsDir = path.join(instanceDir, "mods");
  fs.mkdirSync(modsDir, { recursive: true });

  // 2) Resolve every referenced file id through the CF API, then download what we can.
  const fileIds = (Array.isArray(manifest.files) ? manifest.files : [])
    .map((f) => f && f.fileID).filter((x) => Number.isFinite(x));
  log(`Resolving ${fileIds.length} mod file${fileIds.length === 1 ? "" : "s"}…`);
  const resolved = await resolveFiles(fileIds, key);

  const records = [];
  const manualDownloads = [];      // author disabled API delivery, so no downloadUrl
  const downloadable = resolved.filter((f) => f && f.downloadUrl);
  for (const f of resolved) if (!f.downloadUrl) manualDownloads.push({ modId: f.modId, fileName: f.fileName });

  log(`Downloading ${downloadable.length} file${downloadable.length === 1 ? "" : "s"}…`);
  await pool(downloadable, 8, async (file) => {
    const dest = path.join(modsDir, file.fileName);
    await download(safeURL(file.downloadUrl), dest, sha1Of(file));
    records.push(recordFor(file));
  }, (done, total) => log(`Downloaded ${done}/${total} files.`));

  // 3) Enrich records with real mod names + icons from CF metadata (best-effort).
  const modIds = Array.from(new Set(resolved.map((f) => f.modId).filter((x) => Number.isFinite(x))));
  try {
    const metaById = {};
    for (let i = 0; i < modIds.length; i += 200) {
      const chunk = modIds.slice(i, i + 200);
      const json = await cfPost("mods", { modIds: chunk }, key);
      for (const m of json.data || []) metaById[m.id] = m;
    }
    for (const r of records) {
      const id = Number(String(r.projectId).split(":")[1]);
      const m = metaById[id];
      if (m) { r.title = m.name || r.title; r.iconURL = (m.logo && m.logo.url) || r.iconURL; }
    }
    for (const md of manualDownloads) {
      const m = metaById[md.modId];
      md.title = (m && m.name) || `Mod ${md.modId}`;
      md.url = (m && m.links && m.links.websiteUrl)
        ? m.links.websiteUrl + "/files"
        : `https://www.curseforge.com/projects/${md.modId}`;
    }
  } catch { /* metadata is a nicety; the files are already installed */ }

  // 4) Copy the overrides tree(s) verbatim (client-overrides wins on conflict).
  const overrideCount = extractOverrides(zip, "overrides", instanceDir)
    + extractOverrides(zip, "client-overrides", instanceDir);
  if (overrideCount) log(`Applied ${overrideCount} override file${overrideCount === 1 ? "" : "s"}.`);

  // 5) Populate the instance content list and persist.
  instance.content = records;
  instance.mods = records.filter((c) => c.kind === "mod").length;
  persist(instance);

  if (manualDownloads.length) {
    log(`${manualDownloads.length} mod${manualDownloads.length === 1 ? "" : "s"} must be downloaded by hand (the author disabled API downloads).`);
  }
  log(`Imported “${instance.name}”: ${records.length} file${records.length === 1 ? "" : "s"}, ${overrideCount} override${overrideCount === 1 ? "" : "s"}.`);

  // Return a renderer-facing copy carrying the manual-download list (not persisted).
  return { ...instance, manualDownloads };
}

module.exports = {
  search, installMod, importZip,
  normalizeHit, loaderCode, classId, pickLoader, loaderFromId, sha1Of, pickFile,
};
