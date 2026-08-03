// World creation + import — the Node port of the Mac app's WorldCreator /
// WorldImporter.
//
// THE THING THAT MAKES THIS WORK: level.dat is written with `initialized: 0`.
// That is the fresh-dedicated-server path, so Minecraft itself picks a spawn
// and generates terrain the first time the world loads. Writing our own spawn
// point would fight that, which is why custom spawn is deliberately not here.
//
// ⚠️ MINECRAFT 26.1 SPLIT THE SAVE FORMAT and no online source documents it.
// This was established empirically against real saves and jars on the Mac side:
//
//   classic (<= 1.21.11, DataVersion 4671)
//     worldgen lives in level.dat as WorldGenSettings
//     Difficulty / hardcore / DifficultyLocked, GameRules, DayTime, raining…
//
//   split (26.1+, first seen 26.1.2 = DataVersion 4790)
//     worldgen  -> data/minecraft/world_gen_settings.dat
//     rules     -> data/minecraft/game_rules.dat
//     weather   -> data/minecraft/weather.dat
//     difficulty-> difficulty_settings { difficulty: STRING, hardcore, locked }
//     spawn     -> spawn { pos: intArray, pitch, yaw, dimension }
//     regions   -> dimensions/minecraft/<dim>/
//     each sidecar wraps its payload in `data` and carries its own DataVersion
//     `generate_features` was renamed `generate_structures`
//
// The boundary is exact: difficulty_settings / singleplayer_uuid are absent
// from every jar <= 1.21.11 and present from 26.1.2, so the test is simply
// dataVersion > 4671.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const AdmZip = require("adm-zip");
const nbt = require("./nbt");

const T = nbt.TAGS;

// ---- Node builders on top of nbt.js's {tag, raw} / compound / list shapes ----
const bName = (s) => Buffer.from(s, "utf8");
const nByte = (v) => ({ tag: T.BYTE, raw: Buffer.from([v & 0xff]) });
const nInt = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v | 0); return { tag: T.INT, raw: b }; };
const nLong = (v) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); return { tag: T.LONG, raw: b }; };
const nFloat = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return { tag: T.FLOAT, raw: b }; };
const nDouble = (v) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return { tag: T.DOUBLE, raw: b }; };
function nString(s) {
  const body = Buffer.from(String(s), "utf8");
  const len = Buffer.alloc(2); len.writeUInt16BE(body.length);
  return { tag: T.STRING, raw: Buffer.concat([len, body]) };
}
function nIntArray(values) {
  const b = Buffer.alloc(4 + values.length * 4);
  b.writeInt32BE(values.length, 0);
  values.forEach((v, i) => b.writeInt32BE(v | 0, 4 + i * 4));
  return { tag: T.INT_ARRAY, raw: b };
}
const nCompound = (pairs) => ({ tag: T.COMPOUND, pairs: pairs.map(([k, v]) => [bName(k), v]) });
const nList = (elemTag, items) => ({ tag: T.LIST, elemTag, items });

// ---- Seed parsing: byte-identical to vanilla ---------------------------------
// blank -> random; a plain integer -> used literally (the full 64-bit range,
// which the in-game box cannot even reach); anything else -> Java's
// String.hashCode: h = 31h + c over UTF-16 units, wrapping as int32.
function parseSeed(input) {
  const s = String(input == null ? "" : input).trim();
  if (!s) return randomSeed();
  if (/^-?\d+$/.test(s)) {
    try { return BigInt.asIntN(64, BigInt(s)); } catch { /* fall through to hash */ }
  }
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return BigInt(h);
}
function randomSeed() {
  const b = require("crypto").randomBytes(8);
  return b.readBigInt64BE(0);
}

// ---- DataVersion ------------------------------------------------------------
// Ground truth is version.json INSIDE the client jar, so no table can go stale.
// The small table is only a fallback for a version that isn't downloaded yet.
const DATA_VERSIONS = {
  "1.16.5": 2586, "1.17.1": 2730, "1.18.2": 3120, "1.19.2": 3120,
  "1.20.1": 3465, "1.20.4": 3700, "1.21.1": 3955, "1.21.10": 4556,
  "1.21.11": 4671, "26.1.2": 4790, "26.2": 4903,
};
const CLASSIC_MAX = 4671;   // 1.21.11 — the last pre-26 build

function dataVersionFor(jarPath, mcVersion) {
  try {
    const entry = new AdmZip(jarPath).getEntry("version.json");
    if (entry) {
      const j = JSON.parse(entry.getData().toString("utf8"));
      if (j && Number.isFinite(j.world_version)) return j.world_version;
    }
  } catch { /* fall back to the table */ }
  if (DATA_VERSIONS[mcVersion]) return DATA_VERSIONS[mcVersion];
  // Unknown version: assume modern rather than mangling a new save with an
  // ancient DataVersion, which is what makes the DataFixer destroy a world.
  const major = parseInt(String(mcVersion), 10);
  return Number.isFinite(major) && major >= 26 ? 4903 : 3955;
}

const majorMinor = (v) => {
  const m = String(v).match(/^(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};
// 1.16 introduced WorldGenSettings; below that we cannot author a world at all.
function assertSupported(mcVersion, generator) {
  const [maj, min] = majorMinor(mcVersion);
  const modern = maj >= 26;
  if (!modern && (maj < 1 || (maj === 1 && min < 16))) {
    throw new Error("World creation needs Minecraft 1.16 or newer.");
  }
  if (generator === "flat" && !modern && maj === 1 && min < 18) {
    throw new Error("Superflat needs Minecraft 1.18 or newer.");
  }
}

// ---- Generator presets ------------------------------------------------------
function dimensions(generator, seed, splitFormat) {
  const structuresKey = splitFormat ? "generate_structures" : "generate_features";
  const overworldGen = generator === "flat"
    ? nCompound([
        ["type", nString("minecraft:flat")],
        ["settings", nCompound([
          ["biome", nString("minecraft:plains")],
          ["lakes", nByte(0)],
          ["features", nByte(0)],
          ["layers", nList(T.COMPOUND, [
            nCompound([["block", nString("minecraft:bedrock")], ["height", nInt(1)]]),
            nCompound([["block", nString("minecraft:dirt")], ["height", nInt(2)]]),
            nCompound([["block", nString("minecraft:grass_block")], ["height", nInt(1)]]),
          ])],
        ])],
      ])
    : nCompound([
        ["type", nString("minecraft:noise")],
        ["settings", nString(generator === "amplified" ? "minecraft:amplified"
          : generator === "large_biomes" ? "minecraft:large_biomes" : "minecraft:overworld")],
        ["biome_source", nCompound([
          ["type", nString("minecraft:multi_noise")],
          ["preset", nString("minecraft:overworld")],
        ])],
      ]);

  const dim = (type, gen) => nCompound([["type", nString(type)], ["generator", gen]]);
  return nCompound([
    ["minecraft:overworld", dim("minecraft:overworld", overworldGen)],
    ["minecraft:the_nether", dim("minecraft:the_nether", nCompound([
      ["type", nString("minecraft:noise")],
      ["settings", nString("minecraft:nether")],
      ["biome_source", nCompound([["type", nString("minecraft:multi_noise")], ["preset", nString("minecraft:nether")]])],
    ]))],
    ["minecraft:the_end", dim("minecraft:the_end", nCompound([
      ["type", nString("minecraft:noise")],
      ["settings", nString("minecraft:end")],
      ["biome_source", nCompound([["type", nString("minecraft:the_end")]])],
    ]))],
  ]);
}

function worldGenSettings(opts, splitFormat) {
  const structuresKey = splitFormat ? "generate_structures" : "generate_features";
  return nCompound([
    ["seed", nLong(opts.seed)],
    [structuresKey, nByte(opts.structures === false ? 0 : 1)],
    ["bonus_chest", nByte(opts.bonusChest ? 1 : 0)],
    ["dimensions", dimensions(opts.generator, opts.seed, splitFormat)],
  ]);
}

// nbt.write takes the root name as a Buffer (it writes name.length directly),
// and level.dat's root compound is unnamed — so that's a zero-length buffer.
const gz = (rootName, root) => zlib.gzipSync(nbt.write(Buffer.from(String(rootName), "utf8"), root));
// Sidecars wrap their payload in `data` and carry their own DataVersion.
const sidecar = (dataVersion, pairs) =>
  nCompound([["data", nCompound(pairs)], ["DataVersion", nInt(dataVersion)]]);

// ---- Create -----------------------------------------------------------------
// opts: { instanceDir, mcVersion, jarPath, name, folderName, seed, generator,
//         gameMode, difficulty, hardcore, difficultyLocked, structures,
//         bonusChest, cheats, startingTime, weather, borderSize }
function createWorld(opts) {
  assertSupported(opts.mcVersion, opts.generator);

  const dataVersion = dataVersionFor(opts.jarPath, opts.mcVersion);
  const split = dataVersion > CLASSIC_MAX;
  const seed = parseSeed(opts.seed);

  const savesDir = path.join(opts.instanceDir, "saves");
  fs.mkdirSync(savesDir, { recursive: true });
  const folder = uniqueFolder(savesDir, opts.folderName || opts.name || "New World");
  const dir = path.join(savesDir, folder);
  fs.mkdirSync(dir, { recursive: true });

  const gameMode = { survival: 0, creative: 1, adventure: 2, spectator: 3 }[opts.gameMode] ?? 0;
  const difficulty = { peaceful: 0, easy: 1, normal: 2, hard: 3 }[opts.difficulty] ?? 2;
  const difficultyName = opts.difficulty || "normal";
  const now = BigInt(Date.now());
  const hardcore = opts.hardcore ? 1 : 0;
  const cheats = opts.cheats ? 1 : 0;

  // Region folders differ between the two formats.
  if (split) {
    for (const d of ["overworld", "the_nether", "the_end"]) {
      fs.mkdirSync(path.join(dir, "dimensions", "minecraft", d, "region"), { recursive: true });
    }
    fs.mkdirSync(path.join(dir, "data", "minecraft"), { recursive: true });
  } else {
    fs.mkdirSync(path.join(dir, "region"), { recursive: true });
    fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  }

  const common = [
    ["DataVersion", nInt(dataVersion)],
    ["LevelName", nString(opts.name || folder)],
    ["GameType", nInt(gameMode)],
    ["allowCommands", nByte(cheats)],
    // The whole trick: 0 means "unvisited", so the game generates terrain and
    // chooses a spawn the first time it loads.
    ["initialized", nByte(0)],
    ["LastPlayed", nLong(now)],
    ["Time", nLong(0)],
    ["version", nInt(19133)],
    ["Version", nCompound([
      ["Id", nInt(dataVersion)],
      ["Name", nString(String(opts.mcVersion))],
      ["Snapshot", nByte(0)],
    ])],
  ];

  let levelPairs;
  if (split) {
    levelPairs = [
      ...common,
      ["difficulty_settings", nCompound([
        ["difficulty", nString(difficultyName)],
        ["hardcore", nByte(hardcore)],
        ["locked", nByte(opts.difficultyLocked ? 1 : 0)],
      ])],
      ["singleplayer_uuid", nIntArray(randomUuidInts())],
    ];
  } else {
    levelPairs = [
      ...common,
      ["Difficulty", nByte(difficulty)],
      ["DifficultyLocked", nByte(opts.difficultyLocked ? 1 : 0)],
      ["hardcore", nByte(hardcore)],
      ["WorldGenSettings", worldGenSettings({ seed, generator: opts.generator, structures: opts.structures, bonusChest: opts.bonusChest }, false)],
    ];
    if (opts.startingTime != null) {
      levelPairs.push(["DayTime", nLong(opts.startingTime)]);
    }
    if (opts.weather === "rain" || opts.weather === "thunder") {
      levelPairs.push(["raining", nByte(1)], ["rainTime", nInt(12000)]);
      if (opts.weather === "thunder") levelPairs.push(["thundering", nByte(1)], ["thunderTime", nInt(12000)]);
    }
    if (opts.borderSize) {
      levelPairs.push(
        ["BorderCenterX", nDouble(0)], ["BorderCenterZ", nDouble(0)],
        ["BorderSize", nDouble(Number(opts.borderSize))],
        // ⚠️ classic BorderWarningTime is DOUBLE SECONDS (the split format's
        // warning_time is INT TICKS — do not copy one into the other).
        ["BorderWarningTime", nDouble(15)],
      );
    }
  }

  fs.writeFileSync(path.join(dir, "level.dat"), gz("", nCompound([["Data", nCompound(levelPairs)]])));

  // Split format: worldgen and friends move into their own sidecar files, and
  // each is only written when it differs from the default, so the default path
  // stays the verified-minimal one.
  if (split) {
    const dataDir = path.join(dir, "data", "minecraft");
    fs.writeFileSync(path.join(dataDir, "world_gen_settings.dat"),
      gz("", sidecar(dataVersion, worldGenSettings({ seed, generator: opts.generator, structures: opts.structures, bonusChest: opts.bonusChest }, true).pairs.map(([k, v]) => [k.toString("utf8"), v]))));

    if (opts.weather === "rain" || opts.weather === "thunder") {
      fs.writeFileSync(path.join(dataDir, "weather.dat"), gz("", sidecar(dataVersion, [
        ["raining", nByte(1)], ["rain_time", nInt(12000)],
        ["thundering", nByte(opts.weather === "thunder" ? 1 : 0)],
        ["thunder_time", nInt(12000)], ["clear_weather_time", nInt(0)],
      ])));
    }
    if (opts.startingTime != null) {
      fs.writeFileSync(path.join(dataDir, "world_clocks.dat"), gz("", sidecar(dataVersion, [
        ["minecraft:overworld", nCompound([["total_ticks", nLong(opts.startingTime)]])],
      ])));
    }
    if (opts.borderSize) {
      const borderDir = path.join(dir, "dimensions", "minecraft", "overworld", "data", "minecraft");
      fs.mkdirSync(borderDir, { recursive: true });
      fs.writeFileSync(path.join(borderDir, "world_border.dat"), gz("", sidecar(dataVersion, [
        ["center_x", nDouble(0)], ["center_z", nDouble(0)],
        ["size", nDouble(Number(opts.borderSize))],
        // ⚠️ TICKS as an INT here — the classic file used DOUBLE SECONDS.
        ["warning_time", nInt(300)],
        ["warning_blocks", nInt(5)],
      ])));
    }
  }

  return { folder, dir, dataVersion, split, seed: seed.toString(), quickPlay: supportsQuickPlay(opts.mcVersion) };
}

// Quick Play (--quickPlaySingleplayer) landed in 1.20; before that a launch
// just lands on the title screen and the player opens the world by hand.
function supportsQuickPlay(mcVersion) {
  const [maj, min] = majorMinor(mcVersion);
  return maj >= 26 || (maj === 1 && min >= 20);
}

function randomUuidInts() {
  const b = require("crypto").randomBytes(16);
  return [b.readInt32BE(0), b.readInt32BE(4), b.readInt32BE(8), b.readInt32BE(12)];
}

function uniqueFolder(savesDir, base) {
  const safe = String(base).replace(/[\\/:*?"<>|]/g, "_").trim() || "New World";
  let name = safe, n = 1;
  while (fs.existsSync(path.join(savesDir, name))) name = `${safe} (${++n})`;
  return name;
}

// ---- Import -----------------------------------------------------------------
// Accepts a world folder or a .zip of one. Finds level.dat up to three levels
// deep (zips are commonly wrapped once or twice), ignores __MACOSX, COPIES
// rather than moves so the source is never consumed, and strips a stale
// session.lock that would otherwise make the game refuse to open it.
function importWorld({ instanceDir, source }) {
  const savesDir = path.join(instanceDir, "saves");
  fs.mkdirSync(savesDir, { recursive: true });

  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    const root = findLevelRootOnDisk(source, 3);
    if (!root) throw new Error("That folder doesn't contain a level.dat, so it isn't a Minecraft world.");
    const folder = uniqueFolder(savesDir, path.basename(root));
    const dest = path.join(savesDir, folder);
    fs.cpSync(root, dest, { recursive: true });
    cleanImported(dest);
    return { folder, dir: dest };
  }

  if (!/\.zip$/i.test(source)) throw new Error("Pick a world folder or a .zip of one.");
  const zip = new AdmZip(source);
  const entries = zip.getEntries().filter((e) => !e.entryName.startsWith("__MACOSX/"));
  const level = entries.find((e) => {
    const parts = e.entryName.split("/").filter(Boolean);
    return !e.isDirectory && parts[parts.length - 1] === "level.dat" && parts.length <= 4;
  });
  if (!level) throw new Error("That .zip doesn't contain a level.dat, so it isn't a Minecraft world.");

  const prefix = level.entryName.slice(0, level.entryName.length - "level.dat".length);
  const base = prefix ? prefix.replace(/\/$/, "").split("/").pop() : path.basename(source, path.extname(source));
  const folder = uniqueFolder(savesDir, base || "Imported World");
  const dest = path.join(savesDir, folder);

  for (const e of entries) {
    if (!e.entryName.startsWith(prefix)) continue;
    const rel = e.entryName.slice(prefix.length);
    if (!rel) continue;
    const out = path.join(dest, rel);
    // Never let a crafted archive escape the destination folder.
    if (!path.resolve(out).startsWith(path.resolve(dest))) continue;
    if (e.isDirectory) { fs.mkdirSync(out, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, e.getData());
  }
  cleanImported(dest);
  return { folder, dir: dest };
}

function findLevelRootOnDisk(dir, depth) {
  if (fs.existsSync(path.join(dir, "level.dat"))) return dir;
  if (depth <= 0) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "__MACOSX") continue;
    const found = findLevelRootOnDisk(path.join(dir, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

function cleanImported(dir) {
  for (const junk of ["session.lock", ".DS_Store"]) {
    try { fs.rmSync(path.join(dir, junk), { force: true }); } catch { /* best effort */ }
  }
}

module.exports = { createWorld, importWorld, parseSeed, dataVersionFor, CLASSIC_MAX };
