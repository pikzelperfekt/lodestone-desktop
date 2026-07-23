// [wave0] Smoke test — world rename rewrites level.dat LevelName (engine/nbt.js
// + engine/worlds.js), headless. Builds a synthetic gzipped level.dat by hand
// (every NBT tag type present around LevelName), runs rename, re-parses, and
// asserts LevelName changed while every other tag survived byte-for-byte — for a
// NEW name both longer and shorter than the original (length-prefix handling).
// Run: node scripts/smoke-nbt-rename.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const assert = require("assert");

const nbt = require("../electron/engine/nbt");
const worlds = require("../electron/engine/worlds");

// ---- hand-build NBT bytes (big-endian, Java) ----
const chunks = [];
const push = (...b) => chunks.push(...b);
const u8 = (v) => Buffer.from([v]);
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); return b; };
const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return b; };
const f64 = (v) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return b; };
const name = (s) => { const nb = Buffer.from(s, "utf8"); return Buffer.concat([u16(nb.length), nb]); };
const str = (s) => { const nb = Buffer.from(s, "utf8"); return Buffer.concat([u16(nb.length), nb]); };
// named tag = tagId + name + payload
const tag = (id, key, ...payload) => Buffer.concat([u8(id), name(key), ...payload]);

const ORIG_NAME = "New World";

// Root compound "" → { Data: { …everything… }, version: TAG_Int }
// Data holds a spread of tag types on BOTH sides of LevelName so a mishandled
// length-prefix would corrupt a neighbor and fail the round-trip.
const dataPayload = Buffer.concat([
  tag(nbt.TAGS.BYTE, "hardcore", u8(0)),
  tag(nbt.TAGS.SHORT, "SpawnY", (() => { const b = Buffer.alloc(2); b.writeInt16BE(64); return b; })()),
  tag(nbt.TAGS.INT, "SpawnX", i32(128)),
  tag(nbt.TAGS.LONG, "RandomSeed", i64("1234567890123456789")),
  tag(nbt.TAGS.FLOAT, "BorderSize", f32(60000000.5)),
  tag(nbt.TAGS.DOUBLE, "BorderCenterX", f64(0.5)),
  tag(nbt.TAGS.BYTE_ARRAY, "SomeBytes", i32(3), Buffer.from([9, 8, 7])),
  tag(nbt.TAGS.STRING, "LevelName", str(ORIG_NAME)),
  tag(nbt.TAGS.INT_ARRAY, "SomeInts", i32(2), i32(11), i32(22)),
  tag(nbt.TAGS.LONG_ARRAY, "SomeLongs", i32(1), i64(42)),
  tag(nbt.TAGS.STRING, "generatorName", str("default")),
  // a list of compounds (recursion path)
  tag(nbt.TAGS.LIST, "CustomList", u8(nbt.TAGS.COMPOUND), i32(2),
    Buffer.concat([tag(nbt.TAGS.INT, "a", i32(1)), u8(0)]),
    Buffer.concat([tag(nbt.TAGS.INT, "a", i32(2)), u8(0)])),
  // a list of strings (non-recursive raw path)
  tag(nbt.TAGS.LIST, "ServerBrands", u8(nbt.TAGS.STRING), i32(2), str("vanilla"), str("fabric")),
  u8(0), // end Data
]);
const rootPayload = Buffer.concat([
  Buffer.concat([u8(nbt.TAGS.COMPOUND), name("Data"), dataPayload]),
  tag(nbt.TAGS.INT, "version", i32(19133)),
  u8(0), // end root
]);
const uncompressed = Buffer.concat([u8(nbt.TAGS.COMPOUND), name(""), rootPayload]);

// Snapshot every non-LevelName tag's bytes by re-serializing the parsed tree with
// LevelName forced back to the original — must byte-equal the raw we built.
function assertStructureIntact(rawBytes, label) {
  const p = nbt.parse(rawBytes);
  const data = nbt.getChild(p.root, "Data");
  assert.ok(data, `${label}: Data compound present`);
  // Force LevelName back and re-serialize — should reproduce the original bytes exactly.
  nbt.setString(data, "LevelName", ORIG_NAME);
  const round = nbt.write(p.rootName, p.root);
  assert.ok(round.equals(uncompressed),
    `${label}: every non-LevelName byte must be preserved (round-trip mismatch)`);
}

function runCase(newName, label) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lodestone-nbt-"));
  const worldDir = path.join(dataDir, "instances", "i1", "saves", "World1");
  fs.mkdirSync(worldDir, { recursive: true });
  fs.writeFileSync(path.join(worldDir, "level.dat"), zlib.gzipSync(uncompressed));

  const r = worlds.rename(dataDir, "i1", "World1", newName);
  assert.strictEqual(r.levelNameUpdated, true, `${label}: rename must report LevelName updated`);
  const destDat = path.join(dataDir, "instances", "i1", "saves", newName, "level.dat");
  assert.ok(fs.existsSync(destDat), `${label}: folder renamed + level.dat present`);

  const raw = zlib.gunzipSync(fs.readFileSync(destDat));
  const p = nbt.parse(raw);
  const data = nbt.getChild(p.root, "Data");
  assert.strictEqual(nbt.readString(nbt.getChild(data, "LevelName")), newName,
    `${label}: LevelName must be the new name`);
  // Spot-check a couple of neighbors decode to their exact originals.
  assert.strictEqual(nbt.readString(nbt.getChild(data, "generatorName")), "default",
    `${label}: neighbor string intact`);
  assertStructureIntact(raw, label);

  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`PASS  ${label}  ("${ORIG_NAME}" → "${newName}")`);
}

// Sanity: our hand-built bytes parse and round-trip before any edit.
assert.ok(nbt.write(nbt.parse(uncompressed).rootName, nbt.parse(uncompressed).root).equals(uncompressed),
  "hand-built NBT must round-trip identically");
console.log("PASS  synthetic level.dat round-trips byte-for-byte");

runCase("A Much Longer World Name Than Before", "longer name");   // grows the string
runCase("Hi", "shorter name");                                    // shrinks the string
runCase(ORIG_NAME + "", "same length replacement");               // exercises equal-length path

console.log("\nAll NBT-rename smoke checks passed.");
