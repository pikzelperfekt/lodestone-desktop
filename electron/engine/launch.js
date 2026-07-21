// Builds the JVM + game argument vector and spawns Minecraft. Mirrors
// LodestoneCore's ArgumentBuilder + GameLauncher; classpath separator and java
// binary come from ./platform, so the same code launches on Windows and macOS.
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const platform = require("./platform");
const { ruleAllowed } = require("./install");

// Deterministic offline UUID (md5 of "OfflinePlayer:<name>", v3-formatted) — lets
// the game reach the main menu without a Microsoft session.
function offlineUUID(name) {
  const h = crypto.createHash("md5").update("OfflinePlayer:" + name).digest();
  h[6] = (h[6] & 0x0f) | 0x30; // version 3
  h[8] = (h[8] & 0x3f) | 0x80; // variant
  const hex = h.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function offlineSession(name) {
  return { name, uuid: offlineUUID(name), accessToken: "0", userType: "legacy", offline: true };
}

function resolve(s, subs) {
  return String(s).replace(/\$\{([^}]+)\}/g, (_, k) => (k in subs ? subs[k] : "${" + k + "}"));
}

function flatten(args, subs, features) {
  const out = [];
  for (const a of args || []) {
    if (typeof a === "string") { out.push(resolve(a, subs)); continue; }
    if (a && a.rules && !ruleAllowed(a.rules, features)) continue;
    const val = a && a.value;
    if (Array.isArray(val)) val.forEach((v) => out.push(resolve(v, subs)));
    else if (typeof val === "string") out.push(resolve(val, subs));
  }
  return out;
}

// detail = version JSON; install = { classpath, nativesDir, javaBinary }.
// opts.extraJvm (optional) = extra JVM tokens from the instance's javaArgs.
// opts.overlay (optional) = a mod-loader overlay from loaders.js:
//   { mainClass, extraClasspath:[absPaths], extraJvm:[], extraGame:[] }.
// Loader libraries go *ahead* of the vanilla classpath so the loader's classes win,
// the loader's main class replaces the vanilla one, and its extra args are appended.
function buildArgs(detail, install, session, opts) {
  const overlay = opts.overlay || {};
  const fullClasspath = [...(overlay.extraClasspath || []), ...install.classpath];
  const classpath = fullClasspath.join(platform.classpathSep);
  const subs = {
    auth_player_name: session.name,
    version_name: detail.id,
    game_directory: opts.gameDir,
    assets_root: opts.assetsRoot,
    game_assets: opts.assetsRoot,
    assets_index_name: detail.assets || (detail.assetIndex && detail.assetIndex.id) || "legacy",
    auth_uuid: session.uuid,
    auth_access_token: session.accessToken,
    auth_session: `token:${session.accessToken}:${session.uuid}`,
    auth_xuid: session.xuid || "",
    clientid: "",
    user_type: session.userType || "msa",
    user_properties: "{}",
    version_type: detail.type || "release",
    natives_directory: install.nativesDir,
    launcher_name: "Lodestone",
    launcher_version: "0.1",
    classpath,
    classpath_separator: platform.classpathSep,
    library_directory: opts.librariesDir,
  };
  const features = {};

  let jvm = [];
  if (detail.arguments && detail.arguments.jvm) jvm = flatten(detail.arguments.jvm, subs, features);
  else jvm = [`-Djava.library.path=${install.nativesDir}`, "-cp", classpath];

  if (opts.ramMB) jvm.unshift(`-Xmx${opts.ramMB}M`);
  if (overlay.extraJvm && overlay.extraJvm.length) jvm.push(...flatten(overlay.extraJvm, subs, features));
  // Per-instance user JVM args (free text, already split on whitespace by index.js).
  if (opts.extraJvm && opts.extraJvm.length) jvm.push(...opts.extraJvm.map((a) => resolve(a, subs)));

  let game = [];
  if (detail.arguments && detail.arguments.game) game = flatten(detail.arguments.game, subs, features);
  else if (detail.minecraftArguments) game = detail.minecraftArguments.split(" ").map((s) => resolve(s, subs));
  if (overlay.extraGame && overlay.extraGame.length) game.push(...flatten(overlay.extraGame, subs, features));

  const mainClass = overlay.mainClass || detail.mainClass;
  return [...jvm, mainClass, ...game];
}

function launch(detail, install, session, opts, onLog, onExit) {
  const argv = buildArgs(detail, install, session, opts);
  onLog && onLog(`[Lodestone] java ${install.javaBinary}`);
  const child = spawn(install.javaBinary, argv, { cwd: opts.gameDir });
  const stream = (data) => String(data).split(/\r?\n/).forEach((line) => line && onLog && onLog(line));
  child.stdout.on("data", stream);
  child.stderr.on("data", stream);
  child.on("exit", (code) => onExit && onExit(code == null ? -1 : code));
  child.on("error", (err) => { onLog && onLog("[Lodestone] launch error: " + err.message); onExit && onExit(-1); });
  return child;
}

module.exports = { launch, buildArgs, offlineSession, offlineUUID };
