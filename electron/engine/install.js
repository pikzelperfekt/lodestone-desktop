// Install pipeline — resolves a Minecraft version and downloads everything needed
// to launch it: client jar, libraries (rule-filtered classpath + natives), assets,
// and the exact Mojang Java runtime. Mirrors LodestoneCore's installer/resolver,
// cross-platform via ./platform.
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const platform = require("./platform");
const { getJSON, download, pool } = require("./net");

const MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
const RESOURCES = "https://resources.download.minecraft.net";
const JAVA_ALL = "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

function paths(root) {
  return {
    root,
    versionDir: (id) => path.join(root, "versions", id),
    versionJSON: (id) => path.join(root, "versions", id, `${id}.json`),
    versionJar: (id) => path.join(root, "versions", id, `${id}.jar`),
    libraries: path.join(root, "libraries"),
    assets: path.join(root, "assets"),
    natives: (id) => path.join(root, "natives", id),
    runtime: (component) => path.join(root, "runtimes", component),
    instanceDir: (id) => path.join(root, "instances", id),
  };
}

// --- Mojang rule evaluation (allow/disallow by os.name / os.arch / features) ---
function ruleAllowed(rules, features = {}) {
  if (!rules || !rules.length) return true;
  let allowed = false;
  for (const rule of rules) {
    let applies = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== platform.mojangOSName) applies = false;
      if (rule.os.arch && rule.os.arch !== platform.ARCH) applies = false;
    }
    if (rule.features) {
      for (const [k, v] of Object.entries(rule.features)) {
        if (!!features[k] !== !!v) applies = false;
      }
    }
    if (applies) allowed = rule.action === "allow";
  }
  return allowed;
}

async function resolveVersionJSON(root, id, onLog) {
  const p = paths(root);
  const cached = p.versionJSON(id);
  if (fs.existsSync(cached)) { try { return JSON.parse(fs.readFileSync(cached, "utf8")); } catch {} }
  if (onLog) onLog(`Resolving Minecraft ${id}…`);
  const manifest = await getJSON(MANIFEST);
  const entry = manifest.versions.find((v) => v.id === id);
  if (!entry) throw new Error(`Unknown Minecraft version ${id}`);
  const detail = await getJSON(entry.url);
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, JSON.stringify(detail));
  return detail;
}

// Returns { classpath: [absPaths], nativesDir } after downloading everything.
async function installVersion(root, detail, onProgress, onLog) {
  const p = paths(root);
  const id = detail.id;
  const classpath = [];
  const legacyNatives = [];

  // 1) Client jar
  if (detail.downloads && detail.downloads.client) {
    onLog && onLog("Downloading client…");
    await download(detail.downloads.client.url, p.versionJar(id), detail.downloads.client.sha1);
  }

  // 2) Libraries
  onLog && onLog("Downloading libraries…");
  const ourClassifier = platform.nativesClassifier();
  for (const lib of detail.libraries || []) {
    if (!ruleAllowed(lib.rules)) continue;
    const d = lib.downloads || {};

    // Modern natives: classifier embedded in the name, shipped as `artifact` →
    // belongs on the classpath (LWJGL3 self-extracts at runtime). Skip wrong-arch.
    const classifierMatch = (lib.name || "").match(/:(natives-[a-z0-9-]+)$/);
    if (classifierMatch) {
      if (classifierMatch[1] !== ourClassifier) continue;
    }
    if (d.artifact && d.artifact.path) {
      const dest = path.join(p.libraries, d.artifact.path);
      await download(d.artifact.url, dest, d.artifact.sha1);
      classpath.push(dest);
    }

    // Legacy natives (pre-1.19): an os→classifier map + a classifier jar to extract.
    if (lib.natives && lib.natives[platform.mojangOSName] && d.classifiers) {
      const key = lib.natives[platform.mojangOSName].replace("${arch}", platform.ARCH === "x86" ? "32" : "64");
      const art = d.classifiers[key];
      if (art) {
        const dest = path.join(p.libraries, art.path || `natives/${id}-${key}.jar`);
        await download(art.url, dest, art.sha1);
        legacyNatives.push({ jar: dest, exclude: (lib.extract && lib.extract.exclude) || [] });
      }
    }
  }

  // 2b) Extract any legacy natives into the natives dir.
  const nativesDir = p.natives(id);
  fs.mkdirSync(nativesDir, { recursive: true });
  for (const n of legacyNatives) {
    try {
      const zip = new AdmZip(n.jar);
      for (const e of zip.getEntries()) {
        if (e.isDirectory) continue;
        if (n.exclude.some((ex) => e.entryName.startsWith(ex))) continue;
        if (/\.(dll|so|dylib|jnilib)$/i.test(e.entryName)) {
          fs.writeFileSync(path.join(nativesDir, path.basename(e.entryName)), e.getData());
        }
      }
    } catch {}
  }

  // 3) Assets
  if (detail.assetIndex) {
    onLog && onLog("Downloading assets…");
    const idxPath = path.join(p.assets, "indexes", `${detail.assetIndex.id}.json`);
    await download(detail.assetIndex.url, idxPath, detail.assetIndex.sha1);
    const index = JSON.parse(fs.readFileSync(idxPath, "utf8"));
    const objects = Object.values(index.objects || {});
    await pool(objects, 24, async (o) => {
      const sub = o.hash.slice(0, 2);
      await download(`${RESOURCES}/${sub}/${o.hash}`, path.join(p.assets, "objects", sub, o.hash), o.hash);
    }, (done, total) => onProgress && onProgress("assets", done, total));
  }

  // 4) Java runtime (the exact Mojang JRE this version asks for).
  const component = (detail.javaVersion && detail.javaVersion.component) || "jre-legacy";
  const javaBinary = await installJava(root, component, onProgress, onLog);

  // Client jar goes last on the classpath.
  classpath.push(p.versionJar(id));
  return { classpath, nativesDir, javaBinary, component };
}

async function installJava(root, component, onProgress, onLog) {
  const p = paths(root);
  const dir = p.runtime(component);
  const javaBinary = path.join(dir, platform.javaBinaryRelativePath);
  if (fs.existsSync(javaBinary)) return javaBinary;

  onLog && onLog(`Downloading Java runtime (${component})…`);
  const all = await getJSON(JAVA_ALL);
  const key = platform.javaRuntimeKey();
  const releases = all[key] && all[key][component];
  if (!releases || !releases.length) throw new Error(`No Java runtime "${component}" for ${key}`);
  const manifest = await getJSON(releases[0].manifest.url);
  const files = Object.entries(manifest.files || {});

  await pool(files, 16, async ([rel, info]) => {
    const target = path.join(dir, rel);
    if (info.type === "directory") { fs.mkdirSync(target, { recursive: true }); return; }
    if (info.type === "link") {
      try { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.symlinkSync(info.target, target); } catch {}
      return;
    }
    const dl = info.downloads && (info.downloads.raw || info.downloads.lzma);
    if (!dl) return;
    await download(dl.url, target, dl.sha1);
    if (info.executable && platform.PLATFORM !== "windows") { try { fs.chmodSync(target, 0o755); } catch {} }
  }, (done, total) => onProgress && onProgress("java", done, total));

  if (platform.PLATFORM !== "windows") { try { fs.chmodSync(javaBinary, 0o755); } catch {} }
  return javaBinary;
}

module.exports = { paths, resolveVersionJSON, installVersion, ruleAllowed };
