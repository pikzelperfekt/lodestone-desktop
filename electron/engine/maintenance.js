// Power tools — instance maintenance the launcher can run on demand.
//   • repairInstance:  drop the SHARED cached game files (client jar, libraries index,
//     extracted natives) for an instance's Minecraft version so the next launch pulls a
//     clean copy, WITHOUT touching the instance's own mods / worlds / config.
//   • updateAllContent: walk an instance's Modrinth content and bump anything with a
//     newer build for its loader + Minecraft version, deleting the superseded file.
const fs = require("fs");
const install = require("./install");
const content = require("./content");

// A Modrinth version id is 8-char base62 ([0-9A-Za-z]). CurseForge records store
// "cf:<id>" (and projectId "cf:<modId>"), so this cleanly excludes them along with any
// hand-added / unknown records that can't be re-resolved from Modrinth.
function isModrinthVersionId(id) {
  return typeof id === "string" && /^[0-9A-Za-z]{8}$/.test(id);
}

// Remove ONLY the vanilla version + natives dirs keyed exactly by the instance's
// mcVersion. Loader profile dirs (e.g. "fabric-loader-0.16.0-1.21.1", "neoforge-...")
// carry different names and are left alone, as are the instance's mods/worlds/config
// under instances/<id>/. Returns the absolute dirs that were cleared.
function repairInstance({ dataDir, instance }) {
  if (!instance || !instance.mcVersion) throw new Error("Instance has no Minecraft version to repair.");
  const p = install.paths(dataDir);
  const cleared = [];
  for (const dir of [p.versionDir(instance.mcVersion), p.natives(instance.mcVersion)]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      cleared.push(dir);
    }
  }
  return { cleared };
}

// Re-resolve every Modrinth item in the instance against its loader + MC version; when
// the newest build differs from what's installed, reinstall it (upgrade-in-place by
// projectId, exactly like installContent) and delete the stale file. Mutates
// instance.content in place. Network-bound; non-Modrinth (CurseForge / manual) items are
// skipped. Returns { updated:[{title, from, to}], upToDate:n }.
async function updateAllContent({ dataDir, instance, emit }) {
  const log = (line) => { if (emit) emit("content:log", { instanceId: instance.id, line }); };
  const items = (instance.content || []).slice();   // snapshot: we mutate instance.content below
  const updated = [];
  let upToDate = 0;

  for (const item of items) {
    if (!isModrinthVersionId(item.versionId)) continue;   // CurseForge / manual — not resolvable here
    log(`Checking ${item.title} for updates…`);

    let best;
    try {
      best = await content.bestVersion(item.projectId, item.kind, { loader: instance.loader, mc: instance.mcVersion });
    } catch (e) {
      log(`Couldn't check ${item.title}: ${e.message}`);
      continue;
    }
    if (!best || !best.id) { upToDate++; continue; }
    if (best.id === item.versionId) { upToDate++; continue; }

    log(`Updating ${item.title} to ${best.version_number || best.id}…`);
    let records;
    try {
      records = await content.install({ dataDir, instance, projectId: item.projectId, versionId: best.id, onLog: log });
    } catch (e) {
      log(`Couldn't update ${item.title}: ${e.message}`);
      continue;
    }

    // Merge the freshly installed records in (upgrade-in-place by projectId), then drop
    // the previous jar when its filename actually changed.
    instance.content = instance.content || [];
    const newRec = records.find((r) => r.projectId === item.projectId) || null;
    for (const r of records) {
      const at = instance.content.findIndex((c) => c.projectId === r.projectId);
      if (at >= 0) instance.content[at] = r; else instance.content.push(r);
    }
    if (newRec && newRec.fileName && newRec.fileName !== item.fileName) {
      content.remove({ dataDir, instance, fileName: item.fileName, kind: item.kind });
    }
    updated.push({
      title: item.title,
      from: item.versionNumber || item.versionId,
      to: (newRec && (newRec.versionNumber || newRec.versionId)) || best.version_number || best.id,
    });
  }

  return { updated, upToDate };
}

module.exports = { repairInstance, updateAllContent, isModrinthVersionId };
