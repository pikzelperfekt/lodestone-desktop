// Content management: install / list / remove Modrinth mods, resource packs, and
// shaders for an instance. Mirrors LodestoneCore's ContentInstaller — resolves the
// right version for the instance's loader + Minecraft version, sha1-verifies the
// download into the correct folder, and pulls in required dependencies. The instance's
// `content` array is the record of what's installed (the Mac app's InstalledContent).
const path = require("path");
const fs = require("fs");
const { getJSON, download } = require("./net");
const { paths } = require("./install");

const API = "https://api.modrinth.com/v2";
const UA = { "User-Agent": "Lodestone/0.2 (windows build)" };

// Modrinth project_type → the instance subfolder its files belong in.
const FOLDER = { mod: "mods", resourcepack: "resourcepacks", shader: "shaderpacks" };
function kindFor(projectType) {
  if (projectType === "resourcepack") return "resourcepack";
  if (projectType === "shader") return "shader";
  if (projectType === "mod") return "mod";
  return null; // plugin / datapack / modpack — not installable into an instance this way
}

async function project(id) { return getJSON(`${API}/project/${encodeURIComponent(id)}`, UA); }
async function version(id) { return getJSON(`${API}/version/${encodeURIComponent(id)}`, UA); }

// A project's versions, newest first, scoped to the instance. Mods are loader-scoped;
// resource packs / shaders are not.
async function projectVersions(id, kind, { loader, mc }) {
  const params = new URLSearchParams();
  if (kind === "mod" && loader && loader !== "vanilla") params.set("loaders", JSON.stringify([loader]));
  if (mc) params.set("game_versions", JSON.stringify([mc]));
  const qs = params.toString();
  return getJSON(`${API}/project/${encodeURIComponent(id)}/version${qs ? "?" + qs : ""}`, UA);
}

// Best matching version for this instance, relaxing the MC filter if nothing matches exactly.
async function bestVersion(id, kind, { loader, mc }) {
  let list = await projectVersions(id, kind, { loader, mc });
  if ((!list || !list.length) && mc) list = await projectVersions(id, kind, { loader }); // relax game version
  return (list && list[0]) || null;
}

function primaryFile(v) {
  const files = v.files || [];
  return files.find((f) => f.primary) || files[0];
}

// Install a project + its required dependencies into `instance`. Returns the records
// added. `onLog` is optional. Cycle- and depth-guarded.
async function install({ dataDir, instance, projectId, versionId, onLog }) {
  const installed = [];
  const seen = new Set();

  async function one(pid, vid, depth, requiredBy) {
    if (depth > 8) return;
    const proj = await project(pid);
    const kind = kindFor(proj.project_type);
    if (!kind) {
      if (depth === 0) throw new Error(`“${proj.title}” is a ${proj.project_type}, which isn't installable into an instance yet.`);
      return; // skip an unsupported dependency rather than fail the whole install
    }
    let v = vid ? await version(vid) : await bestVersion(pid, kind, { loader: instance.loader, mc: instance.mcVersion });
    if (!v) {
      if (depth === 0) throw new Error(`No ${instance.loader} build of “${proj.title}” for Minecraft ${instance.mcVersion}.`);
      return;
    }
    if (seen.has(v.id)) return;
    seen.add(v.id);

    const file = primaryFile(v);
    if (!file) return;
    const dest = path.join(paths(dataDir).instanceDir(instance.id), FOLDER[kind], file.filename);
    onLog && onLog(`${requiredBy ? "  ↳ " : ""}Downloading ${proj.title}…`);
    await download(file.url, dest, file.hashes && file.hashes.sha1);
    installed.push({
      projectId: pid, versionId: v.id, title: proj.title, fileName: file.filename,
      kind, iconURL: proj.icon_url || null, size: file.size || 0,
      versionNumber: v.version_number || "", requiredBy: requiredBy || null,
    });

    for (const dep of v.dependencies || []) {
      if (dep.dependency_type !== "required") continue;
      const depProject = dep.project_id || (dep.version_id ? (await version(dep.version_id)).project_id : null);
      if (depProject) await one(depProject, dep.version_id || null, depth + 1, proj.title);
    }
  }

  await one(projectId, versionId || null, 0, null);
  return installed;
}

// Delete an installed file from its instance folder. The Crash Doctor can park a
// jar as "<name>.jar.disabled" (disableMod fix / bisect culprit), so remove that
// form too — otherwise removing a parked mod leaves the orphaned file behind.
function remove({ dataDir, instance, fileName, kind }) {
  const folder = FOLDER[kind] || "mods";
  const file = path.join(paths(dataDir).instanceDir(instance.id), folder, fileName);
  try { fs.rmSync(file, { force: true }); } catch {}
  try { fs.rmSync(file + ".disabled", { force: true }); } catch {}
  return true;
}

module.exports = { install, remove, project, version, projectVersions, bestVersion, kindFor };
