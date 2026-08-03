// Read a world's facts out of level.dat for the World detail page.
//
// Handles BOTH save layouts, because Minecraft 26.1 split the format:
//   classic (<= 1.21.11 / DataVersion 4671) keeps WorldGenSettings, Difficulty,
//     GameRules and the spawn inside level.dat
//   split (26.1+) moves worldgen to data/minecraft/world_gen_settings.dat and
//     replaces Difficulty with difficulty_settings { difficulty, hardcore, locked }
// See worldcreate.js for how those are written; this is the read side.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const nbt = require("./nbt");

const T = nbt.TAGS;

// ---- tiny readers over nbt.js's node shapes --------------------------------
function child(compound, name) {
  if (!compound || compound.tag !== T.COMPOUND) return null;
  const hit = compound.pairs.find(([k]) => k.toString("utf8") === name);
  return hit ? hit[1] : null;
}
const asString = (n) => (n && n.tag === T.STRING ? n.raw.subarray(2).toString("utf8") : null);
const asByte = (n) => (n && n.tag === T.BYTE ? n.raw.readInt8(0) : null);
const asInt = (n) => (n && n.tag === T.INT ? n.raw.readInt32BE(0) : null);
const asLong = (n) => (n && n.tag === T.LONG ? n.raw.readBigInt64BE(0) : null);
function asIntArray(n) {
  if (!n || n.tag !== T.INT_ARRAY) return null;
  const len = n.raw.readInt32BE(0);
  return Array.from({ length: len }, (_, i) => n.raw.readInt32BE(4 + i * 4));
}

function readGz(file) {
  try { return nbt.parse(zlib.gunzipSync(fs.readFileSync(file))).root; }
  catch { return null; }
}

function dirSize(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(full);
    else if (e.isFile()) { try { total += fs.statSync(full).size; } catch { /* vanished */ } }
  }
  return total;
}

const GAME_MODES = ["Survival", "Creative", "Adventure", "Spectator"];
const DIFFICULTIES = ["Peaceful", "Easy", "Normal", "Hard"];

function worldInfo({ instanceDir, folder }) {
  const dir = path.join(instanceDir, "saves", folder);
  const root = readGz(path.join(dir, "level.dat"));
  if (!root) throw new Error("Couldn't read this world's level.dat.");
  const data = child(root, "Data");
  if (!data) throw new Error("That level.dat has no Data compound.");

  const dataVersion = asInt(child(data, "DataVersion"));
  const split = (dataVersion || 0) > 4671;

  // Seed lives in a different place in each format.
  let seed = null;
  const wgs = child(data, "WorldGenSettings");
  if (wgs) seed = asLong(child(wgs, "seed"));
  if (seed === null) {
    const side = readGz(path.join(dir, "data", "minecraft", "world_gen_settings.dat"));
    const inner = side ? child(side, "data") : null;
    if (inner) seed = asLong(child(inner, "seed"));
  }

  // Difficulty + hardcore likewise.
  let difficulty = null, hardcore = null, difficultyLocked = null;
  const ds = child(data, "difficulty_settings");
  if (ds) {
    difficulty = asString(child(ds, "difficulty"));
    if (difficulty) difficulty = difficulty.charAt(0).toUpperCase() + difficulty.slice(1);
    hardcore = asByte(child(ds, "hardcore"));
    difficultyLocked = asByte(child(ds, "locked"));
  } else {
    const d = asByte(child(data, "Difficulty"));
    if (d !== null) difficulty = DIFFICULTIES[d] || String(d);
    hardcore = asByte(child(data, "hardcore"));
    difficultyLocked = asByte(child(data, "DifficultyLocked"));
  }

  // Spawn: a compound in the split format, loose keys in classic.
  let spawn = null;
  const sp = child(data, "spawn");
  if (sp) {
    const pos = asIntArray(child(sp, "pos"));
    if (pos && pos.length >= 3) spawn = { x: pos[0], y: pos[1], z: pos[2] };
  } else {
    const x = asInt(child(data, "SpawnX")), y = asInt(child(data, "SpawnY")), z = asInt(child(data, "SpawnZ"));
    if (x !== null && z !== null) spawn = { x, y: y === null ? 64 : y, z };
  }

  const versionNode = child(data, "Version");
  const gameMode = asInt(child(data, "GameType"));
  const time = asLong(child(data, "Time"));
  const dayTime = asLong(child(data, "DayTime"));

  return {
    folder,
    name: asString(child(data, "LevelName")) || folder,
    dataVersion,
    split,
    versionName: versionNode ? asString(child(versionNode, "Name")) : null,
    seed: seed === null ? null : seed.toString(),
    gameMode: gameMode === null ? null : (GAME_MODES[gameMode] || String(gameMode)),
    difficulty,
    hardcore: hardcore === 1,
    difficultyLocked: difficultyLocked === 1,
    cheats: asByte(child(data, "allowCommands")) === 1,
    initialized: asByte(child(data, "initialized")) === 1,
    lastPlayed: (() => { const v = asLong(child(data, "LastPlayed")); return v === null ? null : Number(v); })(),
    // Ticks -> in-game days, which is the number players actually think in.
    days: time === null ? null : Math.floor(Number(time) / 24000),
    timeOfDay: dayTime === null ? null : Number(dayTime % 24000n),
    size: dirSize(dir),
    dir,
    hasIcon: fs.existsSync(path.join(dir, "icon.png")),
    icon: fs.existsSync(path.join(dir, "icon.png")) ? path.join(dir, "icon.png") : null,
    dimensions: (() => {
      // Which dimensions this world has actually generated.
      const out = [];
      const classic = [["Overworld", "region"], ["Nether", path.join("DIM-1", "region")], ["The End", path.join("DIM1", "region")]];
      const modern = [["Overworld", path.join("dimensions", "minecraft", "overworld", "region")],
                      ["Nether", path.join("dimensions", "minecraft", "the_nether", "region")],
                      ["The End", path.join("dimensions", "minecraft", "the_end", "region")]];
      for (const [label, rel] of (split ? modern : classic)) {
        let n = 0;
        try { n = fs.readdirSync(path.join(dir, rel)).filter((f) => f.endsWith(".mca")).length; } catch { n = 0; }
        if (n) out.push({ name: label, regions: n });
      }
      return out;
    })(),
  };
}

module.exports = { worldInfo };
