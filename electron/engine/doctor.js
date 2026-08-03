// Crash Doctor — reads an instance's newest crash report + latest.log tail, works out
// WHY the game died (missing dependency, wrong-loader/wrong-MC-version mod, OutOfMemory,
// Java mismatch, corrupted files, mixin conflict, world corruption, or "some mod" via
// stack-trace forensics), and returns structured diagnoses whose fixes map onto real
// engine actions (RAM edit, Repair, remove/disable a mod, install a missing dep).
// Also hosts the mod bisector: a user-driven binary search over the enabled mods —
// half get renamed `.jar` → `.jar.disabled`, the user relaunches and reports
// crash / no-crash, and the suspect set halves each round until one culprit remains.
// Bisect state persists to `instances/<id>/doctor-bisect.json` so it survives app
// restarts; abort restores every mod it touched.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { paths } = require("./install");
const content = require("./content");
const maintenance = require("./maintenance");
const settings = require("./settings");

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------
const planner = require("./bisectplanner");

function modsDir(dataDir, instanceId) { return path.join(paths(dataDir).instanceDir(instanceId), "mods"); }
function crashReportsDir(dataDir, instanceId) { return path.join(paths(dataDir).instanceDir(instanceId), "crash-reports"); }
function latestLogFile(dataDir, instanceId) { return path.join(paths(dataDir).instanceDir(instanceId), "logs", "latest.log"); }
function bisectFile(dataDir, instanceId) { return path.join(paths(dataDir).instanceDir(instanceId), "doctor-bisect.json"); }

// Newest crash report under crash-reports/, with its text. Null when there are none.
function newestCrashReport(dataDir, instanceId) {
  const dir = crashReportsDir(dataDir, instanceId);
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  let best = null;
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".txt")) continue;
    const file = path.join(dir, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    if (!best || st.mtimeMs > best.modified) best = { file, name, modified: st.mtimeMs, size: st.size };
  }
  if (!best) return null;
  try { best.text = fs.readFileSync(best.file, "utf8"); } catch { best.text = ""; }
  return best;
}

// The tail of logs/latest.log — last 64 KB, capped at 400 lines. Null when absent.
function latestLogTail(dataDir, instanceId) {
  const file = latestLogFile(dataDir, instanceId);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const CAP = 64 * 1024;
  let text = "";
  try {
    const fd = fs.openSync(file, "r");
    const start = Math.max(0, st.size - CAP);
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString("utf8");
  } catch { return null; }
  const lines = text.split(/\r?\n/);
  if (lines.length > 400) lines.splice(0, lines.length - 400);
  return { file, modified: st.mtimeMs, lines };
}

// ---------------------------------------------------------------------------
// Parsing — pull structured facts out of a crash report + log tail
// ---------------------------------------------------------------------------

// The line containing `index` plus a few following lines — the human-readable
// "evidence" excerpt shown on a diagnosis card.
function excerptAt(text, index, extraLines = 3, maxLen = 700) {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  let end = index;
  for (let i = 0; i <= extraLines; i++) {
    const next = text.indexOf("\n", end + 1);
    if (next === -1) { end = text.length; break; }
    end = next;
  }
  let out = text.slice(lineStart, end).trim();
  if (out.length > maxLen) out = out.slice(0, maxLen) + "…";
  return out;
}

// The first line that reads like a Java exception ("x.y.SomethingException: …").
function firstException(text) {
  const m = text.match(/^([\w$.]+(?:Exception|Error)(?::[^\n]*)?)$/m)
    || text.match(/([\w$.]+(?:Exception|Error):[^\n]*)/);
  return m ? m[1].trim() : null;
}

// Mod list out of a crash report's System Details. Handles both the Fabric/Quilt
// block ("\t\tmodid: Name version") and the Forge/NeoForge pipe table
// ("file.jar |Display Name |modid |version |state").
function parseModList(reportText) {
  const mods = [];
  const seen = new Set();
  const push = (id, name, file) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    mods.push({ id, name: name || id, file: file || null });
  };

  const fabricBlock = reportText.match(/(?:Fabric|Quilt) Mods:\s*\n([\s\S]*?)(?:\n\S|\n\t?\w+ [A-Z]|$)/);
  if (fabricBlock) {
    for (const line of fabricBlock[1].split("\n")) {
      const m = line.match(/^\s+([a-z][a-z0-9_-]*): (.+?) (\S+)\s*$/);
      if (m) push(m[1], m[2], null);
    }
  }
  // Forge-style rows appear anywhere in the Mod List section; the modid is column 3.
  for (const line of reportText.split("\n")) {
    if (!line.includes("|")) continue;
    const cols = line.split("|").map((c) => c.trim());
    if (cols.length >= 4 && /\.jar$/i.test(cols[0]) && /^[a-z][a-z0-9_]*$/.test(cols[2])) {
      push(cols[2], cols[1], cols[0]);
    }
  }
  return mods;
}

// Mixin config files named anywhere in the text → the mod ids they belong to.
// Handles "sodium.mixins.json" and "mixins.betterend.json" naming.
function mixinConfigMods(text) {
  const ids = new Set();
  for (const m of text.matchAll(/([a-z][a-z0-9_.-]{1,63})\.mixins(?:\.[a-z0-9_-]+)*\.json/gi)) {
    if (m[1].toLowerCase() !== "mixins") ids.add(m[1].toLowerCase());
  }
  for (const m of text.matchAll(/mixins\.([a-z][a-z0-9_.-]{1,63})(?:\.[a-z0-9_-]+)*\.json/gi)) {
    ids.add(m[1].toLowerCase());
  }
  return [...ids];
}

// Mod ids hiding in stack frames. Mixin renames injected handlers to
// "…$modid$method…", so "$sodium$" in a frame implicates sodium; matches are
// validated against the crash report's own mod list to avoid false positives.
function stackImplicatedMods(text, knownIds) {
  const known = new Set(knownIds.map((s) => s.toLowerCase()));
  const ids = new Set();
  for (const m of text.matchAll(/\$([a-z][a-z0-9_]{1,63})\$/g)) {
    if (known.has(m[1].toLowerCase())) ids.add(m[1].toLowerCase());
  }
  // Forge crash reports also tag frames with the owning mod: "-- MOD modid --" /
  // "Suspected Mod" blocks are handled separately; "{modid}" markers land here.
  for (const m of text.matchAll(/\{([a-z][a-z0-9_]{1,63})\}/g)) {
    if (known.has(m[1].toLowerCase())) ids.add(m[1].toLowerCase());
  }
  return [...ids];
}

// "Suspected Mods: Iron Chests (ironchest), Other (otherid)" — modern Forge/NeoForge
// crash reports flat-out name the culprits.
function suspectedMods(text) {
  const line = text.match(/Suspected Mods?: ?([^\n]+)/i);
  if (!line) return [];
  const out = [];
  for (const m of line[1].matchAll(/([^(),]+?)\s*\(([a-z0-9_.-]+)\)/g)) {
    out.push({ name: m[1].trim(), id: m[2].toLowerCase() });
  }
  return out;
}

// Dependency errors, both loaders' phrasings:
//  Fabric/Quilt: "Mod 'Sodium Extra' (sodium-extra) 0.5.4 requires version 0.5.3 or
//                 later of 'Sodium' (sodium), which is missing!"
//  Forge/Neo:    "Mod ID: 'cloth_config', Requested by: 'xaeroplus',
//                 Expected range: '[11,)', Actual version: '[MISSING]'"
function parseDepErrors(text) {
  const errors = [];
  const seen = new Set();
  const push = (e) => { const k = e.dep + "|" + e.requester; if (!seen.has(k)) { seen.add(k); errors.push(e); } };

  for (const m of text.matchAll(/Mod '([^']+)' \(([a-z0-9_.-]+)\)[^\n]*? requires (any version|version [^\n]*?) of '?([^'\n(]+?)'? \(([a-z0-9_.-]+)\)([^\n]*)/g)) {
    push({
      requesterName: m[1], requester: m[2].toLowerCase(), requirement: m[3],
      depName: m[4].trim(), dep: m[5].toLowerCase(),
      missing: /which is missing/i.test(m[6]), wrongVersion: /wrong version|only found|but/i.test(m[6]) && !/which is missing/i.test(m[6]),
      at: m.index,
    });
  }
  // Older Fabric phrasing without the dep's display name.
  for (const m of text.matchAll(/requires (any version|version [^,\n]+) of ([a-z][a-z0-9_.-]+), which is missing/g)) {
    push({ requesterName: null, requester: null, requirement: m[1], depName: m[2], dep: m[2].toLowerCase(), missing: true, wrongVersion: false, at: m.index });
  }
  for (const m of text.matchAll(/Mod ID: '([a-z0-9_.-]+)', Requested by: '([a-z0-9_.-]+)', Expected range: '([^']*)', Actual version: '([^']*)'/g)) {
    push({
      requesterName: m[2], requester: m[2].toLowerCase(), requirement: m[3],
      depName: m[1], dep: m[1].toLowerCase(),
      missing: /missing/i.test(m[4]), wrongVersion: !/missing/i.test(m[4]),
      at: m.index,
    });
  }
  return errors;
}

// Fatal loader-abort lines (ported from the Mac app's StartupProbe) — the generic
// "a mod definitely killed the game" signals, kept specific to avoid false alarms.
const FATAL_MARKERS = [
  { needle: "A mod crashed on startup", reason: "A mod crashed on startup." },
  { needle: "Mixin apply failed", reason: "A mixin failed to apply — two mods are patching the same code." },
  { needle: "Mixin prepare failed", reason: "A mixin failed to prepare — likely a mod conflict." },
  { needle: "Incompatible mod set", reason: "Incompatible mod set — mods refuse to load together." },
  { needle: "Missing or unsupported mandatory dependencies", reason: "A mod is missing a required dependency." },
  { needle: "Mod resolution encountered incompatible", reason: "Mods declared incompatible with each other." },
  { needle: "Mod resolution failed", reason: "Mod resolution failed — a dependency/compatibility problem." },
  { needle: "Failed to load mods", reason: "The loader failed to load the mods." },
  { needle: "caught exception during loading", reason: "A mod threw during loading." },
  { needle: "net.fabricmc.loader.impl.FormattedException", reason: "Fabric loader aborted during startup." },
  { needle: "LoaderExceptionModCrash", reason: "A Forge/NeoForge mod crashed during loading." },
  { needle: 'Exception in thread "main"', reason: "The game crashed before the window opened." },
];
function fatalMarker(text) {
  const lower = text.toLowerCase();
  for (const f of FATAL_MARKERS) {
    const at = lower.indexOf(f.needle.toLowerCase());
    if (at !== -1) return { reason: f.reason, at };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Classification — facts → ranked diagnoses with wired fixes
// ---------------------------------------------------------------------------

// Loader-level ids that are never installable content.
const NON_CONTENT_IDS = new Set(["minecraft", "java", "fabricloader", "fabric-loader", "quilt_loader", "forge", "neoforge", "fml"]);

// Well-known "mod id in a dependency error" → Modrinth slug. Anything not here is
// tried as its own slug (Modrinth slugs usually equal mod ids), then hyphenated,
// then resolved through Modrinth search.
const DEP_SLUGS = {
  "fabric": "fabric-api", "fabric-api": "fabric-api", "fabric_api": "fabric-api",
  "cloth_config": "cloth-config", "cloth-config": "cloth-config", "clothconfig": "cloth-config",
  "modmenu": "modmenu", "mod-menu": "modmenu",
  "architectury": "architectury-api",
  "geckolib3": "geckolib", "geckolib": "geckolib",
  "owo": "owo-lib",
  "kotlinforforge": "kotlin-for-forge",
  "fabric-language-kotlin": "fabric-language-kotlin",
  "yet_another_config_lib_v3": "yacl", "yacl": "yacl",
  "resourcefullib": "resourceful-lib",
  "puzzleslib": "puzzles-lib",
  "balm": "balm", "curios": "curios", "trinkets": "trinkets", "collective": "collective",
};

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Match a mod id (or file name) from a log against the instance's installed-content
// records, so a diagnosis can point at a removable/updatable item.
function matchContentRecord(instance, idOrFile) {
  const n = norm(idOrFile);
  if (!n) return null;
  for (const c of instance.content || []) {
    if (norm(c.title) === n || norm(c.fileName).startsWith(n) || norm(c.projectId) === n) return c;
  }
  // Looser pass: the id appears inside the file/title ("sodium" in "sodium-fabric-0.5.jar").
  for (const c of instance.content || []) {
    if (norm(c.fileName).includes(n) || norm(c.title).includes(n)) return c;
  }
  return null;
}

// Match a mod id against the jars actually on disk (covers hand-added mods that
// have no content record). Returns the jar's file name or null.
function matchJarOnDisk(dataDir, instance, modId) {
  const n = norm(modId);
  if (!n) return null;
  let names;
  try { names = fs.readdirSync(modsDir(dataDir, instance.id)); } catch { return null; }
  const jars = names.filter((f) => /\.jar(\.disabled)?$/i.test(f));
  return jars.find((f) => norm(f).startsWith(n)) || jars.find((f) => norm(f).includes(n)) || null;
}

// A mod reference for the UI: id + best-known title/file + content linkage.
function modRef(dataDir, instance, id, name) {
  const rec = matchContentRecord(instance, id) || (name ? matchContentRecord(instance, name) : null);
  const jar = matchJarOnDisk(dataDir, instance, id) || (rec && rec.fileName) || null;
  return {
    id, title: (rec && rec.title) || name || id,
    fileName: jar, projectId: rec ? rec.projectId : null,
  };
}

// Build the ranked diagnosis list. Each entry: { cause, title, confidence, evidence,
// suggestedFix, autoFixable, fix, mods } — `fix` is a descriptor applyFix executes.
function classify({ dataDir, instance, prefs, reportText, logText }) {
  const all = (reportText || "") + "\n" + (logText || "");
  const diagnoses = [];
  const add = (d) => diagnoses.push(d);

  const modList = parseModList(reportText || "");
  const knownIds = modList.map((m) => m.id);

  // 1) Dependency problems (missing / wrong version / wrong MC version / loader version).
  for (const e of parseDepErrors(all)) {
    const evidence = excerptAt(all, e.at != null ? e.at : 0, 2);
    if (e.dep === "minecraft") {
      const who = modRef(dataDir, instance, e.requester || "", e.requesterName);
      add({
        cause: "wrong-mc-version",
        title: `${who.title} needs a different Minecraft version`,
        confidence: "high", evidence,
        suggestedFix: `${who.title} ${e.requirement.replace(/^version /, "needs ")} of Minecraft, but this instance runs ${instance.mcVersion}. Disable the mod, or change the instance's Minecraft version in Settings below.`,
        autoFixable: !!who.fileName,
        fix: who.fileName ? { type: "disableMod", fileName: who.fileName.replace(/\.disabled$/i, "") } : null,
        mods: [who],
      });
      continue;
    }
    if (NON_CONTENT_IDS.has(e.dep)) {
      const who = e.requester ? modRef(dataDir, instance, e.requester, e.requesterName) : null;
      add({
        cause: "loader-version",
        title: `A mod needs a different ${e.depName} version`,
        confidence: "high", evidence,
        suggestedFix: `${who ? who.title : "A mod"} requires ${e.requirement} of ${e.depName}. Update the mod to a build for this pack (or remove it).`,
        autoFixable: false, fix: null,
        mods: who ? [who] : [],
      });
      continue;
    }
    if (e.missing) {
      const who = e.requester ? modRef(dataDir, instance, e.requester, e.requesterName) : null;
      add({
        cause: "missing-dependency",
        title: `Missing dependency: ${e.depName}`,
        confidence: "high", evidence,
        suggestedFix: `${who ? who.title : "A mod"} requires ${e.depName}, which isn't installed. Install it from Modrinth.`,
        autoFixable: true,
        fix: { type: "installDep", depId: e.dep, depName: e.depName },
        mods: who ? [who] : [],
      });
    } else {
      const depRef = modRef(dataDir, instance, e.dep, e.depName);
      add({
        cause: "mismatched-dependency",
        title: `Wrong version of ${e.depName}`,
        confidence: "high", evidence,
        suggestedFix: `${e.requesterName || "A mod"} needs ${e.requirement} of ${e.depName}, but a different version is installed. Update ${e.depName} to a matching build.`,
        autoFixable: !!depRef.projectId && maintenance.isModrinthVersionId((matchContentRecord(instance, e.dep) || {}).versionId),
        fix: depRef.projectId ? { type: "updateMod", projectId: depRef.projectId } : { type: "installDep", depId: e.dep, depName: e.depName },
        mods: [depRef],
      });
    }
  }

  // 2) Out of memory → RAM bump through the existing instance editor.
  {
    const m = all.match(/java\.lang\.OutOfMemoryError(?::? ?([^\n]*))?/);
    if (m) {
      const current = instance.ramMB || prefs.defaultRamMB || 2048;
      const capMB = Math.max(2048, Math.round(os.totalmem() / 1048576) - 2048);
      const suggested = Math.min(Math.max(current + 2048, 4096), capMB);
      const canBump = suggested > current;
      add({
        cause: "out-of-memory",
        title: "The game ran out of memory",
        confidence: "high",
        evidence: excerptAt(all, m.index, 2),
        suggestedFix: canBump
          ? `The JVM heap (${current} MB) was exhausted${m[1] ? ` (${m[1].trim()})` : ""}. Raise this instance's RAM to ${suggested} MB.`
          : `This instance already uses ${current} MB — close to this machine's practical limit. Remove some heavy mods or lower the render distance instead.`,
        autoFixable: canBump,
        fix: canBump ? { type: "ram", ramMB: suggested } : null,
        mods: [],
      });
    }
  }

  // 3) Java version mismatch. The engine installs Mojang's exact runtime, so this
  //    almost always means a Settings→Java override — clearing it is the real fix.
  {
    const m = all.match(/UnsupportedClassVersionError[^\n]*/) || all.match(/[Uu]nsupported class file (?:major )?version (\d+)[^\n]*/)
      || all.match(/has been compiled by a more recent version of the Java Runtime[^\n]*/);
    if (m) {
      const major = (all.match(/class file (?:major )?version (\d+)/) || [])[1];
      const needJava = major ? ` (needs Java ${Number(major) - 44}+)` : "";
      const overridden = !!(prefs.javaPath && prefs.javaPath.trim());
      add({
        cause: "java-version",
        title: "Java version mismatch",
        confidence: "high",
        evidence: excerptAt(all, m.index, 2),
        suggestedFix: overridden
          ? `A class needs a newer Java than the override set in Settings${needJava}. Clear the Java override so Lodestone uses the exact runtime Mojang ships for ${instance.mcVersion}.`
          : `A mod was built for a newer Java than this Minecraft version uses${needJava}. Update the instance's Minecraft version, or remove the mod that needs it.`,
        autoFixable: overridden,
        fix: overridden ? { type: "clearJavaOverride" } : null,
        mods: [],
      });
    }
  }

  // 4) Corrupted files. A ZipException inside the mods folder → that jar is bad
  //    (disable it / re-download); otherwise the shared game files → Repair.
  {
    const m = all.match(/java\.util\.zip\.ZipException[^\n]*/) || all.match(/Invalid or corrupt jarfile ([^\n]*)/)
      || all.match(/Error: Could not find or load main class[^\n]*/);
    if (m) {
      const around = excerptAt(all, m.index, 4);
      const jarInMods = (around.match(/mods[\\/]([^\\/\n"']+\.jar)/i) || [])[1] || null;
      if (jarInMods) {
        add({
          cause: "corrupted-download",
          title: `A mod file is corrupted: ${jarInMods}`,
          confidence: "high", evidence: around,
          suggestedFix: `${jarInMods} can't be read — the download was likely interrupted. Disable it, then re-install the mod.`,
          autoFixable: true,
          fix: { type: "disableMod", fileName: jarInMods },
          mods: [modRef(dataDir, instance, jarInMods.replace(/\.jar$/i, ""), null)],
        });
      } else {
        add({
          cause: "corrupted-download",
          title: "Game files look corrupted",
          confidence: "medium", evidence: around,
          suggestedFix: `A game file can't be read. Run Repair to clear the cached files for Minecraft ${instance.mcVersion}; the next launch re-downloads a clean copy (mods and worlds are untouched).`,
          autoFixable: true,
          fix: { type: "repair" },
          mods: [],
        });
      }
    }
  }

  // 5) Mixin conflicts / failures — two mods patching the same code.
  {
    const m = all.match(/Mixin apply failed[^\n]*|Mixin prepare failed[^\n]*|MixinApplyError[^\n]*|MixinTransformerError[^\n]*|Critical injection failure[^\n]*|InjectionError[^\n]*/);
    if (m) {
      const around = excerptAt(all, m.index, 6, 900);
      const configIds = mixinConfigMods(around.length > 200 ? around : all);
      const refs = configIds.slice(0, 4).map((id) => modRef(dataDir, instance, id, null));
      const two = refs.length >= 2;
      add({
        cause: "mixin-conflict",
        title: two
          ? `Mixin conflict: ${refs[0].title} vs ${refs[1].title}`
          : refs.length === 1 ? `Mixin failure in ${refs[0].title}` : "Mixin failure — a mod conflict",
        confidence: refs.length ? "high" : "medium",
        evidence: around,
        suggestedFix: two
          ? `${refs[0].title} and ${refs[1].title} are patching the same game code and can't coexist. Disable one of them (or update both — newer builds often resolve the clash).`
          : refs.length === 1
            ? `${refs[0].title}'s mixin failed to apply — it likely clashes with another mod. Disable it to confirm, or run the mod bisect below to find its partner in the crash.`
            : "A mixin failed to apply but the log doesn't name the mod. Run the mod bisect below to isolate it.",
        autoFixable: refs.length >= 1 && !!refs[0].fileName,
        fix: refs.length >= 1 && refs[0].fileName ? { type: "disableMod", fileName: refs[0].fileName.replace(/\.disabled$/i, "") } : null,
        mods: refs,
      });
    }
  }

  // 6) A jar the loader can't load at all — usually a mod built for the other loader.
  {
    const m = all.match(/The Mod File (.+?) has mods that were not found/) || all.match(/This file is NOT a valid mod file[^\n]*/i);
    if (m) {
      const jar = m[1] ? path.basename(String(m[1]).trim()) : null;
      const otherLoader = instance.loader === "fabric" || instance.loader === "quilt" ? "Forge/NeoForge" : "Fabric/Quilt";
      add({
        cause: "wrong-loader",
        title: jar ? `${jar} isn't a ${loaderLabel(instance.loader)} mod` : "A mod is built for a different loader",
        confidence: "medium",
        evidence: excerptAt(all, m.index, 2),
        suggestedFix: `${jar || "A mod file"} couldn't be loaded — it's likely a ${otherLoader} build. Disable it and install the ${loaderLabel(instance.loader)} version instead.`,
        autoFixable: !!jar,
        fix: jar ? { type: "disableMod", fileName: jar } : null,
        mods: jar ? [modRef(dataDir, instance, jar.replace(/\.jar$/i, ""), null)] : [],
      });
    }
  }

  // 7) World trouble — corrupted region/level data vs. a mod dying inside a world.
  {
    const io = all.match(/Region file [^\n]*corrupt[^\n]*|ChunkIoException[^\n]*|java\.io\.IOException[^\n]*(?:region|chunk|level\.dat)[^\n]*|Failed to load level[^\n]*/i);
    const tick = all.match(/Exception ticking world|Exception generating new chunk|Exception in server tick loop/i);
    if (io) {
      add({
        cause: "world-corruption",
        title: "World data looks corrupted",
        confidence: "medium",
        evidence: excerptAt(all, io.index, 3),
        suggestedFix: "A world's save data couldn't be read. Restore the newest backup from the Backups section below (make a fresh backup of the broken world first if you want to keep it for repair attempts).",
        autoFixable: false, fix: null, mods: [],
      });
    } else if (tick) {
      const stackIds = stackImplicatedMods(all, knownIds);
      const refs = stackIds.slice(0, 3).map((id) => modRef(dataDir, instance, id, null));
      add({
        cause: "world-crash",
        title: refs.length ? `${refs[0].title} crashed inside the world` : "The game crashed inside a world",
        confidence: refs.length ? "high" : "low",
        evidence: excerptAt(all, tick.index, 4),
        suggestedFix: refs.length
          ? `The crash happened while the world was running and the stack trace points at ${refs[0].title}. Disable or update it.`
          : "The crash happened while a world was running, but no single mod is named. Run the mod bisect below to isolate the culprit.",
        autoFixable: refs.length >= 1 && !!refs[0].fileName,
        fix: refs.length >= 1 && refs[0].fileName ? { type: "disableMod", fileName: refs[0].fileName.replace(/\.disabled$/i, "") } : null,
        mods: refs,
      });
    }
  }

  // 8) Named suspects + stack forensics — when the report itself points at mods.
  if (!diagnoses.some((d) => d.mods && d.mods.length)) {
    const named = suspectedMods(reportText || "");
    const stackIds = named.length ? [] : stackImplicatedMods(all, knownIds);
    const refs = (named.length ? named.map((s) => modRef(dataDir, instance, s.id, s.name))
      : stackIds.map((id) => modRef(dataDir, instance, id, null))).slice(0, 3);
    if (refs.length) {
      const at = all.search(/Suspected Mods?:/i);
      add({
        cause: "mod-crash",
        title: `${refs.map((r) => r.title).join(" + ")} implicated in the crash`,
        confidence: named.length ? "high" : "medium",
        evidence: at >= 0 ? excerptAt(all, at, 2) : (firstException(all) || "See the crash report."),
        suggestedFix: `The ${named.length ? "crash report names" : "stack trace points at"} ${refs.map((r) => r.title).join(" and ")}. Disable ${refs.length > 1 ? "them" : "it"} (or update to a newer build), then relaunch.`,
        autoFixable: !!refs[0].fileName,
        fix: refs[0].fileName ? { type: "disableMod", fileName: refs[0].fileName.replace(/\.disabled$/i, "") } : null,
        mods: refs,
      });
    }
  }

  // 9) Fallback: the game definitely died but nothing above matched — offer the bisect.
  if (!diagnoses.length) {
    const fatal = fatalMarker(all);
    const exc = firstException(all);
    if (fatal || exc || (reportText && reportText.trim())) {
      add({
        cause: "unknown",
        title: fatal ? fatal.reason : "Unrecognized crash",
        confidence: "low",
        evidence: fatal ? excerptAt(all, fatal.at, 3) : (exc || (reportText || "").slice(0, 500)),
        suggestedFix: (instance.loader !== "vanilla" && countEnabledJars(dataDir, instance.id) >= 2)
          ? "No known signature matched. Run the mod bisect below — it disables half your mods per round and pins down the culprit in a handful of launches."
          : "No known signature matched. Try Repair (Settings below) to rule out corrupted game files, and check the crash report for details.",
        autoFixable: false, fix: null, mods: [],
      });
    }
  }

  return diagnoses;
}

function loaderLabel(l) { return l === "vanilla" ? "Vanilla" : l[0].toUpperCase() + l.slice(1); }
function countEnabledJars(dataDir, instanceId) {
  try { return fs.readdirSync(modsDir(dataDir, instanceId)).filter((f) => /\.jar$/i.test(f)).length; } catch { return 0; }
}

// ---------------------------------------------------------------------------
// Scan — the doctor:scan entry point
// ---------------------------------------------------------------------------
function scan({ dataDir, instance, prefs }) {
  const report = newestCrashReport(dataDir, instance.id);
  const log = latestLogTail(dataDir, instance.id);
  const reportText = report ? report.text : "";
  const logText = log ? log.lines.join("\n") : "";

  const diagnoses = classify({ dataDir, instance, prefs: prefs || settings.getSettings(), reportText, logText });
  const exception = firstException(reportText) || firstException(logText);
  const description = (reportText.match(/^Description: ?(.+)$/m) || [])[1] || null;

  return {
    crashReport: report ? { file: report.file, name: report.name, modified: report.modified, size: report.size } : null,
    latestLog: log ? { file: log.file, modified: log.modified } : null,
    description, exception,
    diagnoses,
    enabledMods: countEnabledJars(dataDir, instance.id),
    disabledMods: (() => {
      try { return fs.readdirSync(modsDir(dataDir, instance.id)).filter((f) => /\.jar\.disabled$/i.test(f)).length; } catch { return 0; }
    })(),
  };
}

// ---------------------------------------------------------------------------
// Fixes — descriptors from `classify` executed against the real engine actions
// ---------------------------------------------------------------------------

// Rename a jar between enabled (.jar) and disabled (.jar.disabled). Idempotent.
function setModEnabled(dataDir, instanceId, fileName, enabled) {
  const dir = modsDir(dataDir, instanceId);
  const base = fileName.replace(/\.disabled$/i, "");
  const on = path.join(dir, base);
  const off = path.join(dir, base + ".disabled");
  if (enabled) {
    if (fs.existsSync(on)) return true;
    if (fs.existsSync(off)) { fs.renameSync(off, on); return true; }
  } else {
    if (fs.existsSync(off)) return true;
    if (fs.existsSync(on)) { fs.renameSync(on, off); return true; }
  }
  return false;
}

// Install a dependency named by mod id: known slug → the id itself → hyphenated id →
// Modrinth search, first hit whose slug/title normalizes to the id. Real installs
// via content.install (sha1-verified, dependency-resolving).
async function installMissingDep({ dataDir, instance, depId, onLog }) {
  if (NON_CONTENT_IDS.has(depId)) throw new Error(`"${depId}" is part of the loader/game, not an installable mod.`);
  const tried = new Set();
  const attempts = [DEP_SLUGS[depId], depId, depId.replace(/_/g, "-")].filter((s) => s && !tried.has(s) && tried.add(s));
  let lastErr = null;
  for (const slug of attempts) {
    try { return await content.install({ dataDir, instance, projectId: slug, onLog }); }
    catch (e) { lastErr = e; }
  }
  // Search fallback: scoped to the instance's loader + MC version.
  const facets = [["project_type:mod"]];
  if (instance.loader && instance.loader !== "vanilla") facets.push([`categories:${instance.loader}`]);
  if (instance.mcVersion) facets.push([`versions:${instance.mcVersion}`]);
  const url = new URL("https://api.modrinth.com/v2/search");
  url.searchParams.set("query", depId);
  url.searchParams.set("limit", "10");
  url.searchParams.set("facets", JSON.stringify(facets));
  const res = await fetch(url, { headers: { "User-Agent": "Lodestone/0.2 (windows build)" } });
  if (!res.ok) throw new Error(`Modrinth search ${res.status}`);
  const hits = (await res.json()).hits || [];
  const hit = hits.find((h) => norm(h.slug) === norm(depId) || norm(h.title) === norm(depId)) || hits[0];
  if (!hit) throw new Error(`Couldn't find "${depId}" on Modrinth${lastErr ? ` (${lastErr.message})` : ""}.`);
  return content.install({ dataDir, instance, projectId: hit.project_id, onLog });
}

// Execute one fix descriptor. Mutates `instance` in place where relevant (RAM /
// content records) — the caller persists via the standard instance store, exactly
// like maintenance.updateAllContent.
async function applyFix({ dataDir, instance, fix, onLog }) {
  if (!fix || !fix.type) throw new Error("No fix to apply.");
  switch (fix.type) {
    case "ram": {
      const n = Number(fix.ramMB);
      if (!Number.isFinite(n) || n < 512) throw new Error("Bad RAM amount.");
      instance.ramMB = Math.round(n);
      return { applied: true, message: `RAM raised to ${instance.ramMB} MB.` };
    }
    case "repair": {
      const r = maintenance.repairInstance({ dataDir, instance });
      return { applied: true, message: r.cleared.length ? `Cleared ${r.cleared.length} cached game folder${r.cleared.length === 1 ? "" : "s"} — the next launch re-downloads clean copies.` : "Nothing cached to clear — the next launch verifies everything fresh." };
    }
    case "clearJavaOverride": {
      settings.setSettings({ javaPath: "" });
      return { applied: true, message: "Java override cleared — launches use Mojang's exact runtime again." };
    }
    case "disableMod": {
      if (!fix.fileName) throw new Error("No mod file named.");
      const ok = setModEnabled(dataDir, instance.id, path.basename(fix.fileName), false);
      if (!ok) throw new Error(`${fix.fileName} isn't in this instance's mods folder.`);
      return { applied: true, message: `${path.basename(fix.fileName).replace(/\.disabled$/i, "")} disabled — relaunch to confirm the crash is gone.` };
    }
    case "enableMod": {
      if (!fix.fileName) throw new Error("No mod file named.");
      const ok = setModEnabled(dataDir, instance.id, path.basename(fix.fileName), true);
      if (!ok) throw new Error(`${fix.fileName} isn't in this instance's mods folder.`);
      return { applied: true, message: `${path.basename(fix.fileName).replace(/\.disabled$/i, "")} re-enabled.` };
    }
    case "removeMod": {
      const item = (instance.content || []).find((c) => c.projectId === fix.projectId)
        || (fix.fileName ? (instance.content || []).find((c) => c.fileName === path.basename(fix.fileName).replace(/\.disabled$/i, "")) : null);
      const fileName = (item && item.fileName) || (fix.fileName ? path.basename(fix.fileName).replace(/\.disabled$/i, "") : null);
      if (!fileName) throw new Error("Couldn't work out which file to remove.");
      // The jar may currently be parked as .disabled (post-bisect) — remove either form.
      const dir = modsDir(dataDir, instance.id);
      try { fs.rmSync(path.join(dir, fileName), { force: true }); } catch {}
      try { fs.rmSync(path.join(dir, fileName + ".disabled"), { force: true }); } catch {}
      if (item) instance.content = (instance.content || []).filter((c) => c !== item);
      return { applied: true, message: `${(item && item.title) || fileName} removed from the instance.` };
    }
    case "installDep": {
      const records = await installMissingDep({ dataDir, instance, depId: fix.depId, onLog });
      instance.content = instance.content || [];
      for (const r of records) {
        const at = instance.content.findIndex((c) => c.projectId === r.projectId);
        if (at >= 0) instance.content[at] = r; else instance.content.push(r);
      }
      const names = records.map((r) => r.title).join(", ");
      return { applied: true, message: `Installed ${names || fix.depName || fix.depId}.` };
    }
    case "updateMod": {
      const item = (instance.content || []).find((c) => c.projectId === fix.projectId);
      if (!item) throw new Error("That mod isn't tracked by this instance.");
      const best = await content.bestVersion(item.projectId, item.kind || "mod", { loader: instance.loader, mc: instance.mcVersion });
      if (!best || !best.id) throw new Error(`No ${instance.loader} build of ${item.title} for ${instance.mcVersion}.`);
      if (best.id === item.versionId) return { applied: false, message: `${item.title} is already the newest build (${item.versionNumber || item.versionId}).` };
      const records = await content.install({ dataDir, instance, projectId: item.projectId, versionId: best.id, onLog });
      const newRec = records.find((r) => r.projectId === item.projectId) || null;
      instance.content = instance.content || [];
      for (const r of records) {
        const at = instance.content.findIndex((c) => c.projectId === r.projectId);
        if (at >= 0) instance.content[at] = r; else instance.content.push(r);
      }
      if (newRec && newRec.fileName && newRec.fileName !== item.fileName) {
        content.remove({ dataDir, instance, fileName: item.fileName, kind: item.kind });
      }
      return { applied: true, message: `${item.title} updated to ${(newRec && newRec.versionNumber) || best.version_number || best.id}.` };
    }
    default:
      throw new Error(`Unknown fix "${fix.type}".`);
  }
}

// ---------------------------------------------------------------------------
// Mod bisect — persistent, user-driven binary search over the enabled mods
// ---------------------------------------------------------------------------
// Each round the game runs with everything enabled EXCEPT half of the current
// suspect set. "It crashed" → the culprit was among the enabled suspects (keep
// them); "it ran fine" → the culprit was among the disabled half (swap to them).
// The suspect set halves every round: 32 mods → ~5 launches.

function readBisect(dataDir, instanceId) {
  try { return JSON.parse(fs.readFileSync(bisectFile(dataDir, instanceId), "utf8")); } catch { return null; }
}
function writeBisect(dataDir, instanceId, state) {
  fs.writeFileSync(bisectFile(dataDir, instanceId), JSON.stringify(state, null, 2));
}
function clearBisect(dataDir, instanceId) {
  try { fs.rmSync(bisectFile(dataDir, instanceId), { force: true }); } catch {}
}

// Make the mods folder reflect the state: every mod in `all` enabled except the
// currently-disabled half of the suspects. Files the user deleted mid-bisect are
// skipped gracefully.
function applyBisect(dataDir, instanceId, state) {
  const off = new Set(state.candidates.filter((f) => !state.testing.includes(f)));
  // Pinned libraries stay enabled no matter what. Disabling one produces a
  // DIFFERENT crash (missing dependency), the user reports "crashed", and the
  // hunt then chases the library instead of the real culprit.
  for (const f of state.pinned || []) off.delete(f);
  for (const f of state.all) setModEnabled(dataDir, instanceId, f, !off.has(f));
  state.disabled = [...off];
}

// Drop candidates whose jar vanished from disk entirely (user deleted it mid-hunt).
function pruneMissing(dataDir, instanceId, state) {
  const dir = modsDir(dataDir, instanceId);
  const exists = (f) => fs.existsSync(path.join(dir, f)) || fs.existsSync(path.join(dir, f + ".disabled"));
  state.all = state.all.filter(exists);
  state.candidates = state.candidates.filter(exists);
  state.testing = state.testing.filter((f) => state.candidates.includes(f));
}

// Split the suspects for the next round: first half stays enabled ("testing"),
// the rest get disabled. Deterministic (alphabetical from the start).
function nextRound(state) {
  state.round += 1;
  const half = Math.ceil(state.candidates.length / 2);
  state.testing = state.candidates.slice(0, half);
}

// The UI-facing summary of a bisect state (or inactivity).
function bisectSummary(dataDir, instance, state) {
  if (!state) return { active: false, status: "none" };
  const culpritRef = state.culprit ? modRef(dataDir, instance, state.culprit.replace(/\.jar$/i, ""), null) : null;
  if (culpritRef && state.culprit) culpritRef.fileName = state.culprit;
  return {
    active: state.status === "active",
    status: state.status,
    round: state.round,
    totalMods: state.all.length,
    suspectCount: state.candidates.length,
    testingCount: state.testing.length,
    disabledCount: (state.disabled || []).length,
    phase: state.phase || "all",
    pinnedCount: (state.pinned || []).length,
    disabled: state.disabled || [],
    roundsLeft: state.candidates.length > 1 ? Math.ceil(Math.log2(state.candidates.length)) : 0,
    culprit: culpritRef,
    inconclusive: !!state.inconclusive,
    startedAt: state.startedAt,
    message: state.status === "done"
      ? (state.culprit
        ? `Culprit isolated: ${state.culprit}. Everything else is re-enabled; the culprit stays disabled.`
        : "Bisect finished without isolating a single mod — the crash may involve several mods interacting, or not be mod-related.")
      : state.control
        ? `Control round — all ${state.candidates.length} ordinary mods are off and only the ${(state.pinned || []).length} libraries are loaded. `
          + "Launch it: if it still crashes, the problem is a library and we'll hunt those instead."
      : `Round ${state.round}${state.phase === "libraries" ? " (libraries)" : ""} — ${state.candidates.length} mod${state.candidates.length === 1 ? "" : "s"} suspected, ${(state.disabled || []).length} disabled for this test`
        + `${(state.pinned || []).length ? `, ${state.pinned.length} librar${state.pinned.length === 1 ? "y" : "ies"} held enabled so they can't poison the result` : ""}. `
        + "Launch the instance, then report what happened.",
  };
}

function bisectStatus({ dataDir, instance }) {
  return bisectSummary(dataDir, instance, readBisect(dataDir, instance.id));
}

function bisectStart({ dataDir, instance }) {
  const existing = readBisect(dataDir, instance.id);
  if (existing && existing.status === "active") throw new Error("A mod bisect is already running for this instance.");
  let names;
  try { names = fs.readdirSync(modsDir(dataDir, instance.id)); } catch { names = []; }
  const jars = names.filter((f) => /\.jar$/i.test(f)).sort((a, b) => a.localeCompare(b));
  if (jars.length < 2) throw new Error("Bisecting needs at least two enabled mods.");
  // Plan the hunt: pin libraries, and order the rest so known mixin fighters
  // are split apart first.
  let opening;
  try { opening = planner.plan({ modsDir: modsDir(dataDir, instance.id), jars }); }
  catch { opening = { candidates: jars.slice(), pinned: [], phase: "all" }; }
  const state = {
    version: 2,
    instanceId: instance.id,
    startedAt: Date.now(),
    round: 0,
    all: jars,
    candidates: opening.candidates,
    pinned: opening.pinned,
    phase: opening.phase,
    testing: [],
    disabled: [],
    history: [],
    status: "active",
    culprit: null,
    inconclusive: false,
  };
  // When libraries were pinned, round 1 is a CONTROL round: every ordinary mod
  // off, libraries on. If it still crashes, no candidate can be responsible and
  // the culprit is among the libraries — which also proves pinning them is safe
  // rather than merely assumed.
  if (state.pinned.length) {
    state.control = true;
    state.round = 1;
    state.testing = [];
  } else {
    nextRound(state);
  }
  applyBisect(dataDir, instance.id, state);
  writeBisect(dataDir, instance.id, state);
  return bisectSummary(dataDir, instance, state);
}

function bisectReport({ dataDir, instance, crashed }) {
  const state = readBisect(dataDir, instance.id);
  if (!state || state.status !== "active") throw new Error("No mod bisect is running for this instance.");
  pruneMissing(dataDir, instance.id, state);

  state.history.push({ round: state.round, testing: state.testing.slice(), disabled: state.disabled.slice(), crashed: !!crashed, control: !!state.control });

  if (state.control) {
    state.control = false;
    if (crashed) {
      // Still crashing with every ordinary mod disabled → it's a library.
      const next = planner.libraryPhase({ modsDir: modsDir(dataDir, instance.id), pinned: state.pinned });
      if (next) {
        state.phase = "libraries";
        state.candidates = next.candidates;
        state.pinned = [];
        nextRound(state);
        applyBisect(dataDir, instance.id, state);
        writeBisect(dataDir, instance.id, state);
        return bisectSummary(dataDir, instance, state);
      }
      // Only one library, or none readable: it is the culprit by elimination.
      state.status = "done";
      state.culprit = (state.pinned && state.pinned[0]) || null;
      state.inconclusive = !state.culprit;
      for (const f of state.all) setModEnabled(dataDir, instance.id, f, f !== state.culprit);
      state.disabled = state.culprit ? [state.culprit] : [];
      writeBisect(dataDir, instance.id, state);
      return bisectSummary(dataDir, instance, state);
    }
    // Clean without the ordinary mods: the culprit is among them. Start halving.
    nextRound(state);
    applyBisect(dataDir, instance.id, state);
    writeBisect(dataDir, instance.id, state);
    return bisectSummary(dataDir, instance, state);
  }
  // Crashed with the "testing" half enabled → culprit is in there. Ran fine → the
  // culprit was among the disabled half.
  state.candidates = crashed ? state.testing.slice() : state.candidates.filter((f) => !state.testing.includes(f));

  if (state.candidates.length === 1) {
    state.culprit = state.candidates[0];
    state.status = "done";
    // Restore everything except the culprit, which stays parked as .disabled.
    for (const f of state.all) setModEnabled(dataDir, instance.id, f, f !== state.culprit);
    state.disabled = [state.culprit];
    writeBisect(dataDir, instance.id, state);
    return bisectSummary(dataDir, instance, state);
  }
  if (state.candidates.length === 0 && state.phase === "mods") {
    // Every ordinary mod came up clean, so the culprit is among the libraries
    // we pinned. Escalate rather than ending the hunt in a shrug.
    const next = planner.libraryPhase({ modsDir: modsDir(dataDir, instance.id), pinned: state.pinned });
    if (next) {
      state.phase = "libraries";
      state.candidates = next.candidates;
      state.pinned = [];
      nextRound(state);
      applyBisect(dataDir, instance.id, state);
      writeBisect(dataDir, instance.id, state);
      return bisectSummary(dataDir, instance, state);
    }
  }
  if (state.candidates.length === 0) {
    // Only reachable when jars vanished mid-hunt — nothing left to blame.
    state.status = "done"; state.culprit = null; state.inconclusive = true;
    for (const f of state.all) setModEnabled(dataDir, instance.id, f, true);
    state.disabled = [];
    writeBisect(dataDir, instance.id, state);
    return bisectSummary(dataDir, instance, state);
  }

  nextRound(state);
  applyBisect(dataDir, instance.id, state);
  writeBisect(dataDir, instance.id, state);
  return bisectSummary(dataDir, instance, state);
}

// Abort (or dismiss a finished hunt). restore=true re-enables every mod the hunt
// touched — including a parked culprit; restore=false keeps the mods folder as-is
// and just forgets the session.
function bisectAbort({ dataDir, instance, restore }) {
  const state = readBisect(dataDir, instance.id);
  if (state && restore !== false) {
    for (const f of state.all || []) setModEnabled(dataDir, instance.id, f, true);
  }
  clearBisect(dataDir, instance.id);
  return { cleared: true, restored: restore !== false && !!state };
}

module.exports = {
  scan, applyFix,
  bisectStatus, bisectStart, bisectReport, bisectAbort,
  // exposed for tests / reuse
  setModEnabled, installMissingDep,
  _internal: { parseDepErrors, parseModList, mixinConfigMods, stackImplicatedMods, suspectedMods, firstException, classify, fatalMarker, excerptAt },
};
