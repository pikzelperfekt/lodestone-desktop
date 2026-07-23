// World manager for an instance. Lists the singleplayer worlds under
// instances/<id>/saves/, backs one up as a timestamped zip under
// instances/<id>/backups/, restores a backup back into saves/, renames a world
// folder, and permanently removes one. Pure Node apart from adm-zip for the
// archive, so it behaves identically on Windows and macOS.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const AdmZip = require("adm-zip");
const nbt = require("./nbt"); // [wave0] level.dat LevelName rewrite

function savesDir(dataDir, instanceId) { return path.join(dataDir, "instances", instanceId, "saves"); }
function backupsDir(dataDir, instanceId) { return path.join(dataDir, "instances", instanceId, "backups"); }

// [wave0] Trash-tier deletes (Mac parity): worlds go to the OS Recycle Bin, not
// straight to rm. The trash function is injected (Electron main passes
// shell.trashItem) because these modules also run headless in test scripts —
// with no trash fn the delete stays permanent and reports { trashed: false }.
let trashFn = null;
function setTrash(fn) { trashFn = typeof fn === "function" ? fn : null; }

// A single, safe path segment: no separators, no "." / ".." traversal. Guards every
// name that reaches the filesystem so a crafted world or backup name can't escape
// the instance folder.
function safeName(name) {
  const raw = String(name == null ? "" : name).trim();
  const base = path.basename(raw);
  if (!base || base === "." || base === ".." || raw.includes("/") || raw.includes("\\")) {
    throw new Error("Invalid name.");
  }
  return base;
}

// List each world folder under saves/. Returns { name, icon, modified } newest first.
// icon is the absolute path to the world's icon.png when it exists, else null.
function list(dataDir, instanceId) {
  const dir = savesDir(dataDir, instanceId);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const worlds = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const folder = path.join(dir, e.name);
    let modified = 0;
    try { modified = fs.statSync(folder).mtimeMs; } catch {}
    const iconPath = path.join(folder, "icon.png");
    const icon = fs.existsSync(iconPath) ? iconPath : null;
    worlds.push({ name: e.name, icon, modified });
  }
  return worlds.sort((a, b) => b.modified - a.modified);
}

// List existing backups under backups/, newest first. The world name and timestamp
// are recovered from the "<world>-<ts>.zip" filename.
function backups(dataDir, instanceId) {
  const dir = backupsDir(dataDir, instanceId);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".zip")) continue;
    const file = path.join(dir, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    const m = name.match(/^(.*)-(\d+)\.zip$/i);
    out.push({
      name, file,
      world: m ? m[1] : name.replace(/\.zip$/i, ""),
      created: m ? Number(m[2]) : st.mtimeMs,
      size: st.size,
    });
  }
  return out.sort((a, b) => b.created - a.created);
}

// Zip a world folder into backups/<world>-<ts>.zip and return its record.
function backup(dataDir, instanceId, world) {
  const w = safeName(world);
  const src = path.join(savesDir(dataDir, instanceId), w);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error(`World "${w}" not found.`);
  const dir = backupsDir(dataDir, instanceId);
  fs.mkdirSync(dir, { recursive: true });
  const created = Date.now();
  const file = path.join(dir, `${w}-${created}.zip`);
  const zip = new AdmZip();
  zip.addLocalFolder(src, w); // entries live under "<world>/" so restore recreates the folder
  zip.writeZip(file);
  return { world: w, name: path.basename(file), file, created, size: fs.statSync(file).size };
}

// Unzip a backup back into saves/, overwriting the world folder it contains.
function restore(dataDir, instanceId, backupName) {
  const b = safeName(backupName);
  const file = path.join(backupsDir(dataDir, instanceId), b);
  if (!fs.existsSync(file)) throw new Error("Backup not found.");
  const saves = savesDir(dataDir, instanceId);
  fs.mkdirSync(saves, { recursive: true });
  new AdmZip(file).extractAllTo(saves, true); // true = overwrite existing files
  return true;
}

// [wave0] Rewrite the in-game world name (Data→LevelName TAG_String) inside a
// world's gzipped level.dat, in place and atomically (temp file + rename). Best
// effort: a world that never launched has no level.dat, and a level.dat with no
// Data/LevelName is left alone — the folder rename above is still the visible
// change. Every other byte of the NBT structure is preserved (see nbt.js).
function rewriteLevelName(worldDir, newName) {
  const levelDat = path.join(worldDir, "level.dat");
  if (!fs.existsSync(levelDat)) return false;
  let parsed;
  try {
    const raw = zlib.gunzipSync(fs.readFileSync(levelDat));
    parsed = nbt.parse(raw);
  } catch { return false; }   // unreadable / not gzipped NBT — don't touch it
  const data = nbt.getChild(parsed.root, "Data");
  if (!data) return false;
  nbt.setString(data, "LevelName", newName);
  const regz = zlib.gzipSync(nbt.write(parsed.rootName, parsed.root));
  const tmp = levelDat + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, regz);
  fs.renameSync(tmp, levelDat);   // atomic replace; MC keeps its own level.dat_old
  return true;
}

// Rename a world folder AND rewrite the in-game LevelName so the two stay in sync
// (Mac rewrites LevelName; on Windows the folder name is also the identity, so we
// do both). Refuses to clobber an existing world of the target name.
function rename(dataDir, instanceId, world, newName) {
  const from = safeName(world);
  const to = safeName(newName);
  const saves = savesDir(dataDir, instanceId);
  const src = path.join(saves, from);
  const dest = path.join(saves, to);
  if (!fs.existsSync(src)) throw new Error(`World "${from}" not found.`);
  if (from !== to && fs.existsSync(dest)) throw new Error(`A world named "${to}" already exists.`);
  fs.renameSync(src, dest);
  const levelNameUpdated = rewriteLevelName(dest, to); // [wave0]
  return { name: to, levelNameUpdated };
}

// [wave0] Delete a world folder — to the Recycle Bin when a trash fn is injected
// (Mac parity: worlds are recoverable; only instances are deliberately permanent).
// Headless (no Electron) it falls back to a permanent delete and says so.
async function remove(dataDir, instanceId, world) {
  const w = safeName(world);
  const src = path.join(savesDir(dataDir, instanceId), w);
  if (!fs.existsSync(src)) return { trashed: false };
  if (trashFn) {
    await trashFn(src);   // failure propagates — never silently downgrade to permanent
    return { trashed: true };
  }
  fs.rmSync(src, { recursive: true, force: true });
  return { trashed: false };
}

module.exports = { list, backups, backup, restore, rename, remove, setTrash };
