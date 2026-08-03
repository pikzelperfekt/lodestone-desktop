// Seed search — drive the native cubiomes helper and stream matches back.
//
// ⚠️ THE HARD LIMIT, and why the detector below is not optional: cubiomes only
// models VANILLA worldgen. Checked across 24 real worlds on the Mac side, every
// modded one scored 0-63% against its actual terrain while vanilla scored
// 99.97%. Terralith, BiomesOPlenty, Wover/BetterX and friends replace terrain
// generation outright, so a prediction for those packs is not "slightly off" —
// it is fiction presented with a seed number attached. Any instance carrying a
// worldgen mod is refused rather than answered.
//
// cubiomes maxes out at MC_1_21, but its 1.21 model still matched a 26.x world
// at 99.97% (overworld biome placement is unchanged 1.21 -> 26.x), so it stays
// usable for modern instances.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// Mods that replace or heavily alter overworld generation. Matched loosely
// against jar filenames, which is where we can see them without launching.
const WORLDGEN_MODS = [
  "terralith", "biomesoplenty", "biomes_o_plenty", "byg", "oh_the_biomes",
  "wover", "betterx", "terrablender", "tectonic", "worldgen", "nullscape",
  "amplified_nether", "incendium", "traverse", "regions_unexplored",
  "william_wythers", "geophilic", "lithosphere", "continents", "cavesandcliffs",
];

function detectWorldgenMods(modsDir) {
  let files = [];
  try { files = fs.readdirSync(modsDir); } catch { return []; }
  const hits = [];
  for (const f of files) {
    if (!/\.jar$/i.test(f)) continue;
    const norm = f.toLowerCase().replace(/[^a-z0-9]/g, "_");
    for (const m of WORLDGEN_MODS) {
      if (norm.includes(m)) { hits.push(f); break; }
    }
  }
  return hits;
}

// The helper is bundled beside the app in production and built into native/
// during development.
function helperPath() {
  const exe = process.platform === "win32" ? "seedfinder.exe" : "seedfinder";
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, "native", exe) : null,
    path.join(__dirname, "..", "..", "native", exe),
    path.join(__dirname, "..", "..", "..", "native", exe),
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

function available() { return !!helperPath(); }

// Runs the search, streaming {progress} and {seed} events through onEvent.
// Resolves with the collected seeds. The child is killed if the caller aborts.
function search({ mcVersion, biomes, radius = 1500, count = 5, spacing = 32, startSeed = 1, modsDir, onEvent }) {
  return new Promise((resolve, reject) => {
    const blockers = modsDir ? detectWorldgenMods(modsDir) : [];
    if (blockers.length) {
      reject(new Error(
        `This pack changes world generation (${blockers.slice(0, 3).join(", ")}${blockers.length > 3 ? ", …" : ""}), `
        + "so predicted terrain wouldn't match what you'd actually get. Seed search only works on vanilla generation."));
      return;
    }
    const bin = helperPath();
    if (!bin) { reject(new Error("The seed search helper isn't bundled in this build.")); return; }
    if (!Array.isArray(biomes) || !biomes.length) { reject(new Error("Pick at least one biome to search for.")); return; }

    const args = [String(mcVersion || "1.21.1"), String(radius), String(count), String(spacing), String(startSeed), biomes.join(",")];
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    const seeds = [];
    let buf = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.seed) { seeds.push(msg.seed); if (onEvent) onEvent({ type: "seed", seed: msg.seed }); }
        else if (msg.progress != null && onEvent) onEvent({ type: "progress", checked: msg.progress, found: msg.found });
        else if (msg.done && onEvent) onEvent({ type: "done", checked: msg.checked, found: msg.found });
      }
    });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    child.on("error", (e) => reject(new Error("Couldn't run the seed search: " + e.message)));
    child.on("close", (code) => {
      if (code === 0) resolve({ seeds });
      else reject(new Error(stderr.trim() || `Seed search exited with code ${code}.`));
    });
  });
}

module.exports = { search, available, detectWorldgenMods, WORLDGEN_MODS };
