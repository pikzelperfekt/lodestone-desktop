// Per-instance icons. The icon is a real file (icon.png / icon.jpg / …) inside the
// instance directory — the same convention as the Mac app's Instance.iconFileName —
// tracked on the instance record as `icon` (file name), `iconPath` (absolute path
// the renderer turns into a file:// URL), and `iconVersion` (write timestamp, used
// as a cache-buster). Image decoding/resizing happens in the Electron layer
// (nativeImage in main.js); this module only deals in bytes so it stays pure Node
// and runs headless in tests.
const fs = require("fs");
const path = require("path");
const { paths } = require("./install");

const ICON_EXTS = ["png", "jpg", "jpeg", "webp", "gif"];

function iconCandidates(dir) {
  return ICON_EXTS.map((ext) => path.join(dir, `icon.${ext}`));
}

// Remove every icon.* variant so switching formats never leaves a stale file behind.
function clearIconFiles(dir) {
  for (const file of iconCandidates(dir)) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
}

// Write `buffer` as the instance's icon and stamp the record. Mutates + returns
// `instance`; persisting the store is the caller's job (same contract as content.js).
function setIconBuffer({ dataDir, instance, buffer, ext }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("That icon image is empty.");
  const cleanExt = String(ext || "png").toLowerCase().replace(/^\./, "");
  if (!ICON_EXTS.includes(cleanExt)) throw new Error(`Unsupported icon format ".${cleanExt}" — use PNG or JPEG.`);
  const dir = paths(dataDir).instanceDir(instance.id);
  fs.mkdirSync(dir, { recursive: true });
  clearIconFiles(dir);
  const name = `icon.${cleanExt}`;
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, buffer);
  instance.icon = name;
  instance.iconPath = dest;
  instance.iconVersion = Date.now();
  return instance;
}

// Reset the instance to no icon (the UI falls back to its generated letter tile).
function removeIcon({ dataDir, instance }) {
  clearIconFiles(paths(dataDir).instanceDir(instance.id));
  delete instance.icon;
  delete instance.iconPath;
  delete instance.iconVersion;
  return instance;
}

module.exports = { setIconBuffer, removeIcon, clearIconFiles, ICON_EXTS };
