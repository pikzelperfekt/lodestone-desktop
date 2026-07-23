// [wave0] Smoke test — trash-tier deletes (engine/worlds.js + engine/packs.js), headless.
// Verifies: injected trash fn is used for world/pack deletes ({trashed:true}),
// headless fallback is a permanent delete ({trashed:false}), resource-pack delete
// still scrubs options.txt, and a failing trash fn never falls back to rm.
// Run: node scripts/smoke-trash.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const worlds = require("../electron/engine/worlds");
const packs = require("../electron/engine/packs");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lodestone-trash-"));
const instId = "inst1";
const instDir = path.join(dataDir, "instances", instId);

function mkWorld(name) {
  const d = path.join(instDir, "saves", name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "level.dat"), "stub");
  return d;
}
function mkResourcePack(name) {
  const d = path.join(instDir, "resourcepacks");
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, name);
  // folder-style pack (simplest valid target for delete)
  fs.mkdirSync(f, { recursive: true });
  fs.writeFileSync(path.join(f, "pack.mcmeta"), JSON.stringify({ pack: { pack_format: 15, description: "t" } }));
  return f;
}

// Fake trash: move into a "trash" dir (recoverable), record the calls.
const trashDir = path.join(dataDir, "trash");
fs.mkdirSync(trashDir, { recursive: true });
let trashCalls = [];
const fakeTrash = async (p) => {
  trashCalls.push(p);
  fs.renameSync(p, path.join(trashDir, path.basename(p)));
};

(async () => {
  // 1) Headless (no trash fn): permanent delete, flagged trashed:false.
  mkWorld("Plainworld");
  let r = await worlds.remove(dataDir, instId, "Plainworld");
  assert.deepStrictEqual(r, { trashed: false }, "headless world delete must report trashed:false");
  assert.ok(!fs.existsSync(path.join(instDir, "saves", "Plainworld")), "headless world delete must remove the folder");
  console.log("PASS  headless world delete → permanent, { trashed: false }");

  // 2) Injected trash fn: world goes to trash, not rm'd.
  worlds.setTrash(fakeTrash);
  const w = mkWorld("Trashworld");
  r = await worlds.remove(dataDir, instId, "Trashworld");
  assert.deepStrictEqual(r, { trashed: true }, "world delete with trash fn must report trashed:true");
  assert.ok(!fs.existsSync(w), "world folder must be gone from saves/");
  assert.ok(fs.existsSync(path.join(trashDir, "Trashworld", "level.dat")), "world must be recoverable from trash");
  assert.strictEqual(trashCalls.length, 1, "trash fn called exactly once");
  console.log("PASS  world delete with trash fn → Recycle Bin, { trashed: true }");

  // 3) Resource-pack delete: trashed AND scrubbed from options.txt enabled list.
  packs.setTrash(fakeTrash);
  mkResourcePack("CoolPack");
  fs.writeFileSync(path.join(instDir, "options.txt"), 'resourcePacks:["vanilla","file/CoolPack"]\nfov:0.0\n');
  r = await packs.deletePack(dataDir, instId, "resourcepack", "CoolPack");
  assert.deepStrictEqual(r, { trashed: true }, "pack delete with trash fn must report trashed:true");
  assert.ok(fs.existsSync(path.join(trashDir, "CoolPack")), "pack must be recoverable from trash");
  const opts = fs.readFileSync(path.join(instDir, "options.txt"), "utf8");
  assert.match(opts, /resourcePacks:\["vanilla"\]/, "options.txt must no longer reference the deleted pack");
  assert.match(opts, /fov:0\.0/, "unrelated options.txt lines untouched");
  console.log("PASS  resource-pack delete → Recycle Bin + options.txt scrubbed");

  // 4) Datapack delete (per world) with trash fn.
  const wd = mkWorld("DPWorld");
  const dp = path.join(wd, "datapacks");
  fs.mkdirSync(dp, { recursive: true });
  fs.writeFileSync(path.join(dp, "mypack.zip"), "zipbytes");
  r = await packs.deletePack(dataDir, instId, "datapack", "mypack.zip", "DPWorld");
  assert.deepStrictEqual(r, { trashed: true });
  assert.ok(fs.existsSync(path.join(trashDir, "mypack.zip")), "datapack must be recoverable from trash");
  console.log("PASS  datapack delete → Recycle Bin");

  // 5) A failing trash fn must propagate — never silently fall back to rm.
  worlds.setTrash(async () => { throw new Error("trash unavailable"); });
  const keep = mkWorld("Keepworld");
  let threw = false;
  try { await worlds.remove(dataDir, instId, "Keepworld"); } catch { threw = true; }
  assert.ok(threw, "failing trash fn must throw");
  assert.ok(fs.existsSync(keep), "world must survive a failed trash — no permanent-delete fallback");
  console.log("PASS  failing trash fn → error surfaced, world untouched");

  // Reset injection for any later requires in the same process.
  worlds.setTrash(null); packs.setTrash(null);
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log("\nAll trash-tier smoke checks passed.");
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
