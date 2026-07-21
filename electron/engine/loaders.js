// Mod-loader support. Turns a plain vanilla install into a modded one by resolving a
// loader's profile for a given Minecraft version, downloading the loader's libraries,
// and returning a launch overlay (main class + extra classpath + extra args) that the
// argument builder layers on top of the vanilla version. Mirrors LodestoneCore's
// FabricService + the ArgumentBuilder loader overlay.
//
// Fabric and Quilt share the same meta shape (a "profile JSON" that looks like a Mojang
// version JSON with maven-coordinate libraries), so one code path covers both. NeoForge
// and Forge need a run-the-installer step and are a separate milestone.
const path = require("path");
const { getJSON, download, pool } = require("./net");
const { paths } = require("./install");

const META = {
  fabric: "https://meta.fabricmc.net/v2",
  quilt: "https://meta.quiltmc.org/v3",
};
const DEFAULT_MAVEN = "https://libraries.minecraft.net/";

function supported(loader) { return loader === "fabric" || loader === "quilt"; }

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

// Maven "group:artifact:version[:classifier][@ext]" → repo-relative path.
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

// Download one loader library (sha1-verified when its maven serves a sibling .sha1, so a
// truncated jar on a flaky connection isn't silently cached), return its absolute path.
async function fetchLibrary(root, lib) {
  const base = lib.url || DEFAULT_MAVEN;
  const rel = mavenPath(lib.name);
  const dest = path.join(paths(root).libraries, rel);
  let sha1;
  try {
    const txt = await (await fetch(base + rel + ".sha1")).text();
    const hex = txt.trim().split(/\s+/)[0];
    if (/^[0-9a-f]{40}$/i.test(hex)) sha1 = hex.toLowerCase();
  } catch { /* maven without checksums → fall back to size-check */ }
  await retry(() => download(base + rel, dest, sha1));
  return dest;
}

// Resolve a loader for `mc` and materialize everything needed to launch it.
// Returns { loaderVersion, mainClass, extraClasspath:[absPaths], extraJvm:[], extraGame:[] }.
async function resolveLoader(root, loader, mc, onLog, onProgress) {
  if (!supported(loader)) throw new Error(`${loader} launch isn't supported yet — Fabric and Quilt are.`);
  const version = await latestLoaderVersion(loader, mc);
  onLog && onLog(`Resolving ${loader} ${version} for ${mc}…`);

  const profile = await getJSON(
    `${META[loader]}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(version)}/profile/json`);
  if (!profile.mainClass) throw new Error(`${loader} profile for ${mc} is missing a main class.`);

  const libs = profile.libraries || [];
  const extraClasspath = new Array(libs.length);
  onLog && onLog(`Downloading ${libs.length} ${loader} libraries…`);
  await pool(libs.map((lib, i) => ({ lib, i })), 8,
    async ({ lib, i }) => { extraClasspath[i] = await fetchLibrary(root, lib); },
    (done, total) => onProgress && onProgress("loader", done, total));

  // A tolerant download in the pool can leave a hole; drop any that failed.
  const classpath = extraClasspath.filter(Boolean);
  if (classpath.length !== libs.length) {
    throw new Error(`Couldn't download all ${loader} libraries (${classpath.length}/${libs.length}).`);
  }

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

module.exports = { resolveLoader, supported, mavenPath, latestLoaderVersion };
