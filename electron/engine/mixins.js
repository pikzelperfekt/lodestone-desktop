// Static mixin conflict detection — the Node port of LodestoneCore/Mixins.
// Finds mods that patch the same game method by reading their jars. No launch,
// no crash needed: the static counterpart to Find-the-Culprit bisection.
//
// KEY BYTECODE GOTCHA, and the reason a naive parser finds nothing:
//   @Mixin sits in RuntimeInvisibleAnnotations
//   the injection annotations (@Inject, @Redirect, …) sit in RuntimeVisible
// Both have to be parsed, at BOTH class and method level.
//
// Targets come from @Mixin's `value` (class literals, element tag 'c') or
// `targets` (strings). @Overwrite has NO method= selector — it replaces the
// method matching the handler's own name.
//
// THE SEVERITY MODEL IS THE FEATURE. Naive grouping produced 179 findings on a
// 130-mod pack, which is unusable. Tiering it gave 33 real ones and a count of
// the rest. Mixin applies the HIGHEST priority last, so that mod wins — the
// explanation names the winner rather than saying "these conflict".
const AdmZip = require("adm-zip");

// ---- Java .class parsing (constant pool + annotations only, no bytecode) ----
const CONST = {
  UTF8: 1, INT: 3, FLOAT: 4, LONG: 5, DOUBLE: 6, CLASS: 7, STRING: 8,
  FIELDREF: 9, METHODREF: 10, IFACEREF: 11, NAMEANDTYPE: 12,
  METHODHANDLE: 15, METHODTYPE: 16, DYNAMIC: 17, INVOKEDYNAMIC: 18,
  MODULE: 19, PACKAGE: 20,
};

function parseClass(buf) {
  let i = 0;
  const u1 = () => buf.readUInt8(i++);
  const u2 = () => { const v = buf.readUInt16BE(i); i += 2; return v; };
  const u4 = () => { const v = buf.readUInt32BE(i); i += 4; return v; };

  if (buf.length < 10 || buf.readUInt32BE(0) !== 0xcafebabe) throw new Error("not a class file");
  i = 8;                                   // magic + minor + major

  const count = u2();
  const pool = new Array(count);
  for (let idx = 1; idx < count; idx++) {
    const tag = u1();
    switch (tag) {
      case CONST.UTF8: { const n = u2(); pool[idx] = { tag, value: buf.toString("utf8", i, i + n) }; i += n; break; }
      case CONST.INT: case CONST.FLOAT: { pool[idx] = { tag, value: u4() }; break; }
      // Long and Double each consume TWO constant-pool slots. Miss this and
      // every later index is off by one and the whole parse silently rots.
      case CONST.LONG: case CONST.DOUBLE: { i += 8; pool[idx] = { tag }; idx++; break; }
      case CONST.CLASS: case CONST.STRING: case CONST.METHODTYPE:
      case CONST.MODULE: case CONST.PACKAGE: { pool[idx] = { tag, ref: u2() }; break; }
      case CONST.FIELDREF: case CONST.METHODREF: case CONST.IFACEREF:
      case CONST.NAMEANDTYPE: case CONST.DYNAMIC: case CONST.INVOKEDYNAMIC: { pool[idx] = { tag, a: u2(), b: u2() }; break; }
      case CONST.METHODHANDLE: { i += 3; pool[idx] = { tag }; break; }
      default: throw new Error("unknown constant tag " + tag);
    }
  }
  const utf8 = (idx) => (pool[idx] && pool[idx].tag === CONST.UTF8 ? pool[idx].value : null);
  const className = (idx) => (pool[idx] && pool[idx].tag === CONST.CLASS ? utf8(pool[idx].ref) : null);

  u2();                                    // access_flags
  const thisClass = className(u2());
  u2();                                    // super_class
  const ifaceCount = u2(); i += ifaceCount * 2;

  // ---- annotation decoding ----
  function readElementValue() {
    const tag = String.fromCharCode(u1());
    switch (tag) {
      case "B": case "C": case "D": case "F": case "I": case "J": case "S": case "Z": {
        const idx = u2(); const c = pool[idx];
        return c && c.value !== undefined ? c.value : null;
      }
      case "s": return utf8(u2());
      case "e": { u2(); return utf8(u2()); }        // enum: type, then const name
      case "c": return utf8(u2());                   // class literal -> descriptor
      case "@": return readAnnotation();
      case "[": { const n = u2(); const out = []; for (let k = 0; k < n; k++) out.push(readElementValue()); return out; }
      default: throw new Error("unknown element tag " + tag);
    }
  }
  function readAnnotation() {
    const type = utf8(u2());
    const n = u2();
    const values = {};
    for (let k = 0; k < n; k++) {
      const name = utf8(u2());
      values[name] = readElementValue();
    }
    return { type, values };
  }
  function readAnnotationsAttr(len) {
    const end = i + len;
    const n = u2();
    const out = [];
    for (let k = 0; k < n; k++) {
      try { out.push(readAnnotation()); } catch { break; }
    }
    i = end;                                // always resync, even on a bad decode
    return out;
  }
  function readAttributes() {
    const n = u2();
    const anns = [];
    for (let k = 0; k < n; k++) {
      const nameIdx = u2();
      const len = u4();
      const name = utf8(nameIdx);
      // BOTH kinds matter: @Mixin is invisible, the injectors are visible.
      if (name === "RuntimeVisibleAnnotations" || name === "RuntimeInvisibleAnnotations") {
        anns.push(...readAnnotationsAttr(len));
      } else {
        i += len;
      }
    }
    return anns;
  }

  const fieldCount = u2();
  for (let k = 0; k < fieldCount; k++) { u2(); u2(); u2(); readAttributes(); }

  const methodCount = u2();
  const methods = [];
  for (let k = 0; k < methodCount; k++) {
    u2();
    const name = utf8(u2());
    const desc = utf8(u2());
    const anns = readAttributes();
    methods.push({ name, desc, annotations: anns });
  }
  const classAnnotations = readAttributes();

  return { thisClass, classAnnotations, methods };
}

// ---- Mixin vocabulary --------------------------------------------------------
const MIXIN_DESC = "Lorg/spongepowered/asm/mixin/Mixin;";
// Two mods doing these to the same method genuinely fight: one silently loses.
const EXCLUSIVE = { Overwrite: "@Overwrite", Redirect: "@Redirect" };
// These stack, but the ORDER changes the result.
const ORDER_SENSITIVE = {
  ModifyArg: "@ModifyArg", ModifyArgs: "@ModifyArgs",
  ModifyConstant: "@ModifyConstant", ModifyVariable: "@ModifyVariable",
};
// Designed to coexist. Reporting these is noise, which is what made the naive
// version unusable — never surface them.
const COOPERATIVE = new Set(["Inject", "WrapOperation", "WrapMethod", "ModifyReturnValue", "WrapWithCondition"]);
const HARMLESS = new Set(["Accessor", "Invoker"]);

const simpleName = (desc) => {
  if (!desc) return null;
  const m = String(desc).match(/([A-Za-z0-9_$]+);?$/);
  return m ? m[1] : null;
};

// Normalise a selector so `Lowner;name()V`, `name()V` and `name*` compare equal.
function normalizeSelector(sel) {
  if (!sel) return null;
  let s = String(sel).trim();
  s = s.replace(/^L[^;]*;/, "");            // strip an owner prefix
  s = s.replace(/\*$/, "");                 // trailing wildcard
  const paren = s.indexOf("(");
  return (paren >= 0 ? s.slice(0, paren) : s).trim() || null;
}

function targetsOf(mixinAnnotation) {
  const v = mixinAnnotation.values || {};
  const out = [];
  const push = (x) => { const n = simpleName(x); if (n) out.push(n); };
  if (Array.isArray(v.value)) v.value.forEach(push); else if (v.value) push(v.value);
  if (Array.isArray(v.targets)) v.targets.forEach((t) => out.push(String(t).split(/[./]/).pop()));
  else if (v.targets) out.push(String(v.targets).split(/[./]/).pop());
  return [...new Set(out)];
}

// ---- Scan one jar ------------------------------------------------------------
function scanJar(jarPath, modName) {
  const zip = new AdmZip(jarPath);
  const entries = zip.getEntries();

  // Two-pass extraction: find the mixin configs first, then read only those
  // packages' classes. Expanding whole jars is far too slow across 130 mods.
  //
  // Config NAMES are not a reliable pattern: Sodium ships sodium-common.mixins
  // .json (suffix) while Iris ships mixins.iris.json (prefix). Matching either
  // filename shape alone misses half the ecosystem, so the mod metadata — which
  // lists them explicitly — is the authority, with a filename sweep as backup.
  const declared = new Set();
  const fabricMeta = zip.getEntry("fabric.mod.json") || zip.getEntry("quilt.mod.json");
  if (fabricMeta) {
    try {
      const j = JSON.parse(fabricMeta.getData().toString("utf8"));
      const list = j.mixins || (j.quilt_loader && j.quilt_loader.mixins) || [];
      for (const m of [].concat(list)) declared.add(typeof m === "string" ? m : m && m.config);
    } catch { /* fall back to the sweep */ }
  }
  // Forge/NeoForge declare configs in the jar manifest instead.
  const manifest = zip.getEntry("META-INF/MANIFEST.MF");
  if (manifest) {
    const line = manifest.getData().toString("utf8").match(/MixinConfigs:\s*(.+)/i);
    if (line) line[1].split(",").forEach((c) => declared.add(c.trim()));
  }

  const configs = entries.filter((e) => !e.isDirectory && (
    declared.has(e.entryName)
    || (!e.entryName.includes("/") && /(^mixins?\..*\.json$)|(\.mixins?\.json$)/i.test(e.entryName))
  ));
  if (!configs.length) return [];

  const declarations = [];
  for (const cfg of configs) {
    let json;
    try { json = JSON.parse(cfg.getData().toString("utf8")); } catch { continue; }
    const pkg = String(json.package || "").replace(/\./g, "/");
    if (!pkg) continue;
    const names = [...(json.mixins || []), ...(json.client || []), ...(json.server || [])];
    for (const rel of names) {
      const entryName = `${pkg}/${String(rel).replace(/\./g, "/")}.class`;
      const entry = zip.getEntry(entryName);
      if (!entry) continue;
      let parsed;
      try { parsed = parseClass(entry.getData()); } catch { continue; }

      const mixinAnn = parsed.classAnnotations.find((a) => a.type === MIXIN_DESC);
      if (!mixinAnn) continue;
      const priority = Number(mixinAnn.values && mixinAnn.values.priority) || 1000;
      const targets = targetsOf(mixinAnn);
      if (!targets.length) continue;

      for (const m of parsed.methods) {
        for (const ann of m.annotations) {
          const kind = simpleName(ann.type);
          if (!kind) continue;
          if (HARMLESS.has(kind) || COOPERATIVE.has(kind)) continue;
          const exclusive = !!EXCLUSIVE[kind];
          const ordered = !!ORDER_SENSITIVE[kind];
          if (!exclusive && !ordered) continue;

          // @Overwrite carries no method= selector: it replaces the method
          // matching the handler's own name.
          const raw = ann.values && (ann.values.method || ann.values.value);
          const selectors = kind === "Overwrite"
            ? [m.name]
            : (Array.isArray(raw) ? raw : raw ? [raw] : [m.name]);

          for (const sel of selectors) {
            const target = normalizeSelector(sel);
            if (!target) continue;
            for (const t of targets) {
              declarations.push({
                mod: modName, priority, kind: EXCLUSIVE[kind] || ORDER_SENSITIVE[kind],
                exclusive, targetClass: t, targetMethod: target, handler: m.name,
              });
            }
          }
        }
      }
    }
  }
  return declarations;
}

// ---- Detect ------------------------------------------------------------------
function analyze(declarations) {
  const groups = new Map();
  for (const d of declarations) {
    const key = `${d.targetClass}#${d.targetMethod}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }

  const conflicts = [];
  let counted = 0;
  for (const [key, list] of groups) {
    const mods = [...new Set(list.map((d) => d.mod))];
    if (mods.length < 2) continue;             // one mod patching itself is fine

    const hasExclusive = list.some((d) => d.exclusive);
    if (!hasExclusive) { counted++; continue; } // order-sensitive only: counted, not listed

    // Mixin applies the HIGHEST priority last, so that mod's version survives.
    // But only when one mod actually holds the top priority alone — at a tie
    // the order is down to mod load order, which we cannot know from the jars.
    // Claiming a winner there would be a confident guess dressed as a fact.
    const topPriority = Math.max(...list.map((d) => d.priority));
    const topMods = [...new Set(list.filter((d) => d.priority === topPriority).map((d) => d.mod))];
    const [targetClass, targetMethod] = key.split("#");

    // One row per mod+kind rather than one per declaration — a mod with eight
    // @ModifyArgs on the same method is one fact, not eight.
    const seen = new Set();
    const rows = [];
    for (const d of list) {
      const k = d.mod + "|" + d.kind;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ mod: d.mod, kind: d.kind, priority: d.priority });
    }

    const decided = topMods.length === 1;
    const losers = mods.filter((m) => m !== topMods[0]);
    conflicts.push({
      targetClass, targetMethod,
      severity: decided ? "likely" : "unpredictable",
      mods: rows,
      winner: decided ? topMods[0] : null,
      explanation: decided
        ? `${topMods[0]} (priority ${topPriority}) applies last and wins. `
          + `${losers.join(", ")} ${losers.length === 1 ? "loses its" : "lose their"} change to `
          + `${targetClass}.${targetMethod} silently.`
        : `${topMods.join(", ")} all sit at priority ${topPriority} on ${targetClass}.${targetMethod}, `
          + `so which one wins comes down to mod load order — it can change between launches or machines.`,
    });
  }

  conflicts.sort((a, b) => b.mods.length - a.mods.length);
  return { conflicts, cooperativeOverlaps: counted, scanned: declarations.length };
}

module.exports = { parseClass, scanJar, analyze, normalizeSelector };
