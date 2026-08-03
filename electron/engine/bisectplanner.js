// Bisection planner — the Node port of LodestoneCore/Diagnostics/BisectionPlanner.
//
// A naive bisect splits the mod list in half alphabetically and halves again.
// On a real 130-mod pack that fails in a specific way: disabling a LIBRARY that
// other mods require doesn't reproduce the original crash, it produces a
// DIFFERENT one (a missing-dependency failure). The user reports "crashed", the
// search follows that answer, and the hunt converges on the wrong mod. The
// library is the poison, not the culprit.
//
// So the planner does three things:
//   1. PIN libraries. Anything another mod declares as a dependency stays
//      enabled for the whole ordinary hunt, and is never a candidate.
//   2. ORDER by mixin-conflict suspicion. Mods already known to fight over the
//      same game method (from the static scanner) sort to the front, so the
//      first split is far more likely to separate the real culprit early.
//   3. FALL BACK to a library phase. If the ordinary mods all come up clean,
//      the libraries themselves become the candidate set rather than the hunt
//      ending in a shrug.
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const mixins = require("./mixins");

// Well-known libraries that frequently ship without anyone declaring a hard
// dependency on them, but which half the pack still loads against.
const KNOWN_LIBRARIES = [
  "fabric-api", "fabric_api", "fabric-language-kotlin", "architectury",
  "cloth-config", "clothconfig", "forgeconfigapiport", "bookshelf",
  "balm", "kotlinforforge", "collective", "puzzleslib", "resourcefullib",
  "terrablender", "creativecore", "geckolib", "playeranimator",
  "yungsapi", "supermartijn642", "moonlight", "mixinextras", "midnightlib",
  "owolib", "sodium", "iris",   // load-bearing for rendering mods
];

// Read a jar's declared mod id and its dependency ids. Fabric/Quilt keep them
// in fabric.mod.json; Forge/NeoForge use a TOML we read loosely rather than
// pulling in a parser for three fields.
function readModMeta(jarPath) {
  const meta = { id: null, depends: [] };
  let zip;
  try { zip = new AdmZip(jarPath); } catch { return meta; }

  const fabric = zip.getEntry("fabric.mod.json") || zip.getEntry("quilt.mod.json");
  if (fabric) {
    try {
      const j = JSON.parse(fabric.getData().toString("utf8"));
      const loader = j.quilt_loader || j;
      meta.id = loader.id || j.id || null;
      const deps = loader.depends || j.depends || {};
      if (Array.isArray(deps)) {
        for (const d of deps) meta.depends.push(typeof d === "string" ? d : (d && (d.id || d.name)));
      } else {
        meta.depends.push(...Object.keys(deps));
      }
    } catch { /* unreadable metadata is not fatal */ }
  }

  const toml = zip.getEntry("META-INF/mods.toml") || zip.getEntry("META-INF/neoforge.mods.toml");
  if (toml) {
    try {
      const text = toml.getData().toString("utf8");
      if (!meta.id) {
        const m = text.match(/^\s*modId\s*=\s*"([^"]+)"/m);
        if (m) meta.id = m[1];
      }
      // [[dependencies.<mod>]] blocks each carry their own modId line.
      const depBlocks = text.split(/\[\[dependencies\./).slice(1);
      for (const b of depBlocks) {
        const m = b.match(/modId\s*=\s*"([^"]+)"/);
        if (m) meta.depends.push(m[1]);
      }
    } catch { /* same */ }
  }

  meta.depends = [...new Set(meta.depends.filter(Boolean).map((d) => String(d).toLowerCase()))]
    .filter((d) => d !== "minecraft" && d !== "java" && d !== "fabricloader" && d !== "forge" && d !== "neoforge");
  return meta;
}

// Which jars are libraries: anything another mod depends on, plus the
// well-known list. Returns a Set of file names.
function findLibraries(modsDir, jars) {
  const byId = new Map();
  const metas = new Map();
  for (const f of jars) {
    const meta = readModMeta(path.join(modsDir, f));
    metas.set(f, meta);
    if (meta.id) byId.set(String(meta.id).toLowerCase(), f);
  }

  const libs = new Set();
  for (const [, meta] of metas) {
    for (const dep of meta.depends) {
      const file = byId.get(dep);
      if (file) libs.add(file);
    }
  }
  for (const f of jars) {
    const norm = f.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const known of KNOWN_LIBRARIES) {
      if (norm.includes(known.replace(/[^a-z0-9]/g, ""))) { libs.add(f); break; }
    }
  }
  return { libraries: libs, metas };
}

// Rank jars so the most-suspicious sort first. Mods that the static scanner
// already caught fighting over a method are the best first split.
//
// `scanSet` is the jars to READ (all of them) while `jars` is the subset to
// ORDER. Those differ on purpose: a candidate that fights a pinned library is
// still a prime suspect, but scanning only the candidates makes that conflict
// invisible and every score collapses to zero.
function suspicionOrder(modsDir, jars, scanSet) {
  const score = new Map(jars.map((f) => [f, 0]));
  let declarations = [];
  for (const f of (scanSet && scanSet.length ? scanSet : jars)) {
    try { declarations = declarations.concat(mixins.scanJar(path.join(modsDir, f), f)); }
    catch { /* unreadable jar just scores zero */ }
  }
  if (declarations.length) {
    const { conflicts } = mixins.analyze(declarations);
    for (const c of conflicts) {
      for (const m of c.mods) {
        // scanJar was given the FILE NAME as the mod name, so this maps back.
        if (score.has(m.mod)) score.set(m.mod, score.get(m.mod) + (c.severity === "likely" ? 3 : 2));
      }
    }
  }
  // Ties stay alphabetical so a hunt is reproducible across runs.
  return [...jars].sort((a, b) => (score.get(b) - score.get(a)) || a.localeCompare(b));
}

// Build the opening plan for a hunt.
function plan({ modsDir, jars }) {
  const { libraries } = findLibraries(modsDir, jars);
  const ordinary = jars.filter((f) => !libraries.has(f));

  // If pinning would leave nothing to test, don't pin — a pack that is all
  // libraries still deserves a hunt.
  const usable = ordinary.length >= 2 ? ordinary : jars.slice();
  const pinned = ordinary.length >= 2 ? [...libraries] : [];

  return {
    candidates: suspicionOrder(modsDir, usable, jars),
    pinned,
    phase: ordinary.length >= 2 ? "mods" : "all",
  };
}

// When the ordinary phase finds nothing, hand back the library phase.
function libraryPhase({ modsDir, pinned }) {
  if (!pinned || pinned.length < 2) return null;
  return { candidates: suspicionOrder(modsDir, pinned, pinned), phase: "libraries" };
}

module.exports = { plan, libraryPhase, findLibraries, suspicionOrder, readModMeta, KNOWN_LIBRARIES };
