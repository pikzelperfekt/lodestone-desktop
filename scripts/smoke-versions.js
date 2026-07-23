// [wave0] Smoke test — snapshots & historical versions (engine/index.js
// listVersions + engine/install.js runtime selection). Uses the real Mojang
// manifest (network). Verifies default = releases only, opt-in channels return
// snapshots/old_beta/old_alpha, and that a real old version (b1.7.3) resolves to
// the correct Mojang JRE runtime component ("jre-legacy").
// Run: node scripts/smoke-versions.js
const assert = require("assert");
const os = require("os");
const fs = require("fs");
const path = require("path");

const engine = require("../electron/engine");
const install = require("../electron/engine/install");

(async () => {
  // 1) Default: releases only, no snapshot/old channels present.
  const def = await engine.listVersions();
  assert.ok(Array.isArray(def.releases) && def.releases.length > 100, "default: releases present");
  assert.ok(def.releases.includes("1.20.4"), "default: a known release is listed");
  assert.strictEqual(def.snapshots, undefined, "default: NO snapshots key");
  assert.strictEqual(def.old_beta, undefined, "default: NO old_beta key");
  assert.strictEqual(def.old_alpha, undefined, "default: NO old_alpha key");
  // Default must not smuggle a snapshot into releases.
  assert.ok(!def.releases.some((id) => /-pre|-rc|w\d\d[a-z]/.test(id)), "default: releases are pure releases");
  console.log(`PASS  default → releases only (${def.releases.length} releases, no other channels)`);

  // 2) Opt in to snapshots.
  const withSnaps = await engine.listVersions({ channels: ["snapshot"] });
  assert.ok(Array.isArray(withSnaps.snapshots) && withSnaps.snapshots.length > 0, "snapshot channel returns ids");
  assert.ok(withSnaps.snapshots.some((id) => /w\d\d[a-z]/.test(id) || /-pre|-rc/.test(id)), "snapshots look like snapshots");
  assert.deepStrictEqual(withSnaps.releases, def.releases, "opting into snapshots doesn't change releases");
  console.log(`PASS  { channels:["snapshot"] } → ${withSnaps.snapshots.length} snapshots, releases unchanged`);

  // 3) Opt in to historical alpha/beta.
  const withOld = await engine.listVersions({ channels: ["old_beta", "old_alpha"] });
  assert.ok(withOld.old_beta.includes("b1.7.3"), "old_beta includes b1.7.3");
  assert.ok(withOld.old_alpha.length > 0, "old_alpha present");
  console.log(`PASS  { channels:["old_beta","old_alpha"] } → ${withOld.old_beta.length} beta / ${withOld.old_alpha.length} alpha`);

  // 4) Unknown channel names are ignored (no throw, no stray key).
  const bogus = await engine.listVersions({ channels: ["nonsense"] });
  assert.strictEqual(bogus.nonsense, undefined, "unknown channel ignored");
  console.log("PASS  unknown channel names ignored safely");

  // 5) Runtime component for a real old version. b1.7.3's version JSON has no
  //    javaVersion, so install.js falls back to "jre-legacy" — the correct old
  //    runtime (runs natively on Windows x64, no Rosetta anything).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lodestone-ver-"));
  const detail = await install.resolveVersionJSON(root, "b1.7.3");
  const component = (detail.javaVersion && detail.javaVersion.component) || "jre-legacy";
  assert.strictEqual(component, "jre-legacy", "b1.7.3 must select the jre-legacy runtime");
  // And a modern version selects a modern component, proving the field is honored.
  const modern = await install.resolveVersionJSON(root, "1.20.4");
  const modernComponent = (modern.javaVersion && modern.javaVersion.component) || "jre-legacy";
  assert.notStrictEqual(modernComponent, "jre-legacy", "1.20.4 selects a modern runtime, not legacy");
  assert.match(modernComponent, /^java-runtime-/, "1.20.4 runtime is a java-runtime-* component");
  console.log(`PASS  runtime component: b1.7.3 → ${component}, 1.20.4 → ${modernComponent}`);

  fs.rmSync(root, { recursive: true, force: true });
  console.log("\nAll versions smoke checks passed.");
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
