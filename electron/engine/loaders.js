// Mod-loader support. Turns a plain vanilla install into a modded one by resolving a
// loader's profile for a given Minecraft version, downloading the loader's libraries,
// and returning a launch overlay (main class + extra classpath + extra args) that the
// argument builder layers on top of the vanilla version. Mirrors LodestoneCore's
// FabricService + the ArgumentBuilder loader overlay.
//
// Two shapes of loader:
//   * Fabric / Quilt: a hosted "profile JSON" (a Mojang-version-JSON lookalike with
//     maven-coordinate libraries). One code path covers both.
//   * NeoForge / Forge: no hosted profile exists; the official installer jar has to be
//     run once, headless, to patch the client and emit a version profile. We then read
//     that profile and overlay it exactly like Fabric's.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { getJSON, download, pool } = require("./net");
const { paths, resolveVersionJSON, installJava } = require("./install");

const META = {
  fabric: "https://meta.fabricmc.net/v2",
  quilt: "https://meta.quiltmc.org/v3",
};
const DEFAULT_MAVEN = "https://libraries.minecraft.net/";

// Installer-based loaders: maven root (for installer jars + libraries) and the
// maven-metadata that lists every published build.
const NEOFORGE_MAVEN = "https://maven.neoforged.net/releases/";
const NEOFORGE_META = NEOFORGE_MAVEN + "net/neoforged/neoforge/maven-metadata.xml";
const FORGE_MAVEN = "https://maven.minecraftforge.net/";
const FORGE_META = FORGE_MAVEN + "net/minecraftforge/forge/maven-metadata.xml";
const UA = "Lodestone/0.1 (prototype)";

function supported(loader) {
  return loader === "fabric" || loader === "quilt" || loader === "neoforge" || loader === "forge";
}

// Retry a flaky async op a few times with linear backoff. Loader libraries come from
// third-party mavens over what is often a throttled connection, so a lone dropped
// request shouldn't fail the whole launch.
async function retry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
  }
  throw last;
}

async function getText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}

// Maven "group:artifact:version[:classifier][@ext]" -> repo-relative path.
function mavenPath(name) {
  const [coord, ext] = name.split("@");
  const parts = coord.split(":");
  const group = parts[0], artifact = parts[1], version = parts[2], classifier = parts[3];
  const file = `${artifact}-${version}${classifier ? "-" + classifier : ""}.${ext || "jar"}`;
  return `${group.replace(/\./g, "/")}/${artifact}/${version}/${file}`;
}

// Newest loader build for this MC version — the stable one when the meta marks it, else
// the first listed (the API returns newest-first).
async function latestLoaderVersion(loader, mc) {
  const list = await getJSON(`${META[loader]}/versions/loader/${encodeURIComponent(mc)}`);
  if (!Array.isArray(list) || !list.length) throw new Error(`No ${loader} build for Minecraft ${mc}.`);
  const stable = list.find((e) => e.loader && e.loader.stable);
  const chosen = (stable || list[0]).loader;
  if (!chosen || !chosen.version) throw new Error(`No ${loader} build for Minecraft ${mc}.`);
  return chosen.version;
}

// Download one loader library, return its absolute path. Handles both library shapes:
//   * Fabric/Quilt: { name, url? } where url is a maven *base*; path is derived from the
//     coordinate and the sibling .sha1 verifies the download.
//   * NeoForge/Forge/Mojang: { name, downloads: { artifact: { url, path, sha1 } } } where
//     url is the full artifact URL (an empty url means the installer produced it locally).
async function fetchLibrary(root, lib) {
  const art = lib.downloads && lib.downloads.artifact;
  if (art && (art.url || art.path)) {
    const rel = art.path || mavenPath(lib.name);
    const dest = path.join(paths(root).libraries, rel);
    if (art.url) {
      await retry(() => download(art.url, dest, art.sha1 || undefined));
    } else if (!fs.existsSync(dest)) {
      throw new Error(`Library ${lib.name} has no download URL and isn't present on disk.`);
    }
    return dest;
  }
  const base = lib.url || DEFAULT_MAVEN;
  const rel = mavenPath(lib.name);
  const dest = path.join(paths(root).libraries, rel);
  let sha1;
  try {
    const txt = await (await fetch(base + rel + ".sha1")).text();
    const hex = txt.trim().split(/\s+/)[0];
    if (/^[0-9a-f]{40}$/i.test(hex)) sha1 = hex.toLowerCase();
  } catch { /* maven without checksums -> fall back to size-check */ }
  await retry(() => download(base + rel, dest, sha1));
  return dest;
}

// Download every library a profile lists and return the absolute paths, in order.
// NeoForge/Forge profiles put the module-path jars here too, so the whole set must land.
async function fetchProfileLibraries(root, libs, loader, onLog, onProgress) {
  const out = new Array(libs.length);
  onLog && onLog(`Verifying ${libs.length} ${loader} libraries...`);
  await pool(libs.map((lib, i) => ({ lib, i })), 8,
    async ({ lib, i }) => { out[i] = await fetchLibrary(root, lib); },
    (done, total) => onProgress && onProgress("loader", done, total));
  const classpath = out.filter(Boolean);
  if (classpath.length !== libs.length) {
    throw new Error(`Couldn't resolve all ${loader} libraries (${classpath.length}/${libs.length}).`);
  }
  return classpath;
}

// ---- Fabric / Quilt (hosted profile) ----
async function resolveHostedLoader(root, loader, mc, onLog, onProgress) {
  const version = await latestLoaderVersion(loader, mc);
  onLog && onLog(`Resolving ${loader} ${version} for ${mc}...`);

  const profile = await getJSON(
    `${META[loader]}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(version)}/profile/json`);
  if (!profile.mainClass) throw new Error(`${loader} profile for ${mc} is missing a main class.`);

  const classpath = await fetchProfileLibraries(root, profile.libraries || [], loader, onLog, onProgress);
  const args = profile.arguments || {};
  const strings = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === "string") : []);
  return {
    loaderVersion: version,
    mainClass: profile.mainClass,
    extraClasspath: classpath,
    extraJvm: strings(args.jvm),
    extraGame: strings(args.game),
  };
}

// ---- NeoForge / Forge (run-the-installer) ----

// Parse the <version> entries out of a maven-metadata.xml. Regex is enough; the file is
// a flat, machine-generated list and we only ever want the version strings.
function parseMavenVersions(xml) {
  const out = [];
  const re = /<version>([^<]+)<\/version>/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}

// Compare two dotted versions numerically. A build with a pre-release suffix (a "-tag")
// sorts *below* the same numbers without one, matching semver. Returns >0 if a > b.
function cmpVersion(a, b) {
  const [na, ...sa] = a.split("-");
  const [nb, ...sb] = b.split("-");
  const pa = na.split(".").map(Number), pb = nb.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  const ta = sa.join("-"), tb = sb.join("-");
  if (!ta && tb) return 1;
  if (ta && !tb) return -1;
  return ta === tb ? 0 : (ta < tb ? -1 : 1);
}

// Newest of a list, preferring stable (suffix-free) builds when any exist.
function pickNewest(list) {
  const stable = list.filter((v) => !v.includes("-"));
  const from = stable.length ? stable : list;
  return from.reduce((best, v) => (cmpVersion(v, best) > 0 ? v : best));
}

// NeoForge numbers a build "MINOR.PATCH.BUILD" for Minecraft "1.MINOR.PATCH" (e.g.
// 21.1.66 -> 1.21.1, 20.4.190 -> 1.20.4). Its very first line kept Forge's 47.x scheme
// for 1.20.1, which we accept as a fallback.
function neoforgePrefixes(mc) {
  const p = mc.split(".");
  const minor = p[1], patch = p[2] || "0";
  if (!/^\d+$/.test(minor || "")) return [];
  const prefixes = [`${minor}.${patch}.`];
  if (mc === "1.20.1") prefixes.push("47.");
  return prefixes;
}

function pickNeoforgeVersion(versions, mc) {
  const prefixes = neoforgePrefixes(mc);
  const matched = prefixes.length ? versions.filter((v) => prefixes.some((p) => v.startsWith(p))) : [];
  if (!matched.length) throw new Error(`No NeoForge build is published for Minecraft ${mc}.`);
  return pickNewest(matched);
}

// Forge versions are the full "MC-FORGE" string (e.g. "1.20.1-47.4.21"); we compare on the
// forge portion so builds for other Minecraft versions never win.
function pickForgeVersion(versions, mc) {
  const prefix = mc + "-";
  const matched = versions.filter((v) => v.startsWith(prefix));
  if (!matched.length) throw new Error(`No Forge build is published for Minecraft ${mc}.`);
  return matched.reduce((best, v) =>
    (cmpVersion(v.slice(prefix.length), best.slice(prefix.length)) > 0 ? v : best));
}

// The exact Mojang Java runtime this Minecraft version wants. installVersion already
// downloaded it for the base install, so this is a cache hit in the normal launch flow.
async function ensureJava(root, mc, onLog, onProgress) {
  const detail = await resolveVersionJSON(root, mc, onLog);
  const component = (detail.javaVersion && detail.javaVersion.component) || "jre-legacy";
  return installJava(root, component, onProgress, onLog);
}

// The Forge/NeoForge installer edits launcher_profiles.json to register its profile and
// refuses to run if the file is missing. We never read it back, so an empty one is fine.
function ensureLauncherProfiles(root) {
  const f = path.join(root, "launcher_profiles.json");
  if (!fs.existsSync(f)) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ profiles: {} }));
  }
}

// Run the installer jar headless, streaming its (chatty) output to the launch log and
// keeping a rolling tail so a non-zero exit carries a useful message.
function runInstaller(javaBinary, args, onLog) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(javaBinary, args); }
    catch (e) { reject(e); return; }
    const tail = [];
    const feed = (data) => String(data).split(/\r?\n/).forEach((line) => {
      if (!line) return;
      tail.push(line);
      if (tail.length > 30) tail.shift();
      onLog && onLog(line);
    });
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`Installer exited with code ${code}.\n${tail.join("\n")}`)));
  });
}

// Resolve NeoForge/Forge: work out the newest build for `mc`, run its official installer
// once (it patches the vanilla client and drops a version profile), then overlay that
// profile exactly like Fabric's.
async function resolveInstallerLoader(root, loader, mc, onLog, onProgress) {
  const nice = loader === "neoforge" ? "NeoForge" : "Forge";
  const p = paths(root);

  let loaderVersion, installerUrl, id, installFlag;
  if (loader === "neoforge") {
    const version = pickNeoforgeVersion(parseMavenVersions(await getText(NEOFORGE_META)), mc);
    loaderVersion = version;
    installerUrl = `${NEOFORGE_MAVEN}net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
    id = `neoforge-${version}`;
    installFlag = "--install-client";
  } else {
    const full = pickForgeVersion(parseMavenVersions(await getText(FORGE_META)), mc); // "1.20.1-47.4.21"
    loaderVersion = full.slice((mc + "-").length); // "47.4.21"
    installerUrl = `${FORGE_MAVEN}net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
    id = `${mc}-forge-${loaderVersion}`;
    installFlag = "--installClient";
  }
  onLog && onLog(`Resolving ${nice} ${loaderVersion} for ${mc}...`);

  const profilePath = p.versionJSON(id);
  if (fs.existsSync(profilePath)) {
    onLog && onLog(`${nice} ${loaderVersion} is already installed.`);
  } else {
    const java = await ensureJava(root, mc, onLog, onProgress);
    const installerPath = path.join(root, "installers", `${id}-installer.jar`);
    onLog && onLog(`Downloading the ${nice} installer...`);
    await retry(() => download(installerUrl, installerPath));
    ensureLauncherProfiles(root);
    onLog && onLog(`Running the ${nice} installer (downloads Minecraft and patches the client, this can take a minute)...`);
    onProgress && onProgress("installer", 0, 1);
    await runInstaller(java, ["-Djava.awt.headless=true", "-jar", installerPath, installFlag, root], onLog);
    onProgress && onProgress("installer", 1, 1);
    if (!fs.existsSync(profilePath)) {
      throw new Error(`The ${nice} installer finished but did not produce ${id}.json.`);
    }
  }

  let profile;
  try { profile = JSON.parse(fs.readFileSync(profilePath, "utf8")); }
  catch (e) { throw new Error(`Couldn't read the ${nice} profile ${id}: ${e.message}`); }
  if (!profile.mainClass) throw new Error(`${nice} profile ${id} is missing a main class.`);

  const classpath = await fetchProfileLibraries(root, profile.libraries || [], nice, onLog, onProgress);
  const args = profile.arguments || {};
  return {
    loaderVersion,
    mainClass: profile.mainClass,
    extraClasspath: classpath,
    extraJvm: Array.isArray(args.jvm) ? args.jvm : [],
    extraGame: Array.isArray(args.game) ? args.game : [],
  };
}

// Resolve a loader for `mc` and materialize everything needed to launch it.
// Returns { loaderVersion, mainClass, extraClasspath:[absPaths], extraJvm:[], extraGame:[] }.
async function resolveLoader(root, loader, mc, onLog, onProgress) {
  if (loader === "neoforge" || loader === "forge") {
    return resolveInstallerLoader(root, loader, mc, onLog, onProgress);
  }
  if (!supported(loader)) throw new Error(`${loader} launch isn't supported.`);
  return resolveHostedLoader(root, loader, mc, onLog, onProgress);
}

module.exports = {
  resolveLoader, supported, mavenPath, latestLoaderVersion,
  // Exposed for tests + reuse.
  parseMavenVersions, cmpVersion, pickNewest,
  pickNeoforgeVersion, pickForgeVersion, neoforgePrefixes,
  resolveInstallerLoader, fetchLibrary,
};
