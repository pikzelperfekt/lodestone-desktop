// Chunk pregeneration.
//
// Generating terrain ahead of time removes the stutter of exploring a fresh
// world. There is no way to do that from the client, so this runs a HEADLESS
// SERVER for the instance and drives Chunky (a Modrinth mod) through its
// console.
//
// It runs on the instance's OWN loader and mods, which matters: a pack with
// Terralith or BiomesOPlenty must generate its terrain, not vanilla's, or the
// pregenerated chunks are wrong and the game regenerates nothing.
//
// Console formats are taken from Chunky's own lang/en.json rather than guessed:
//   format_start  "[Chunky] Task started for <world>..."
//   task_update   "[Chunky] <world> ... <pct>% complete ... ETA <eta>"
//   task_done     "[Chunky] Task finished for <world>"
// Radius is in BLOCKS, which is what the `chunky radius` command expects.
const path = require("path");
const fs = require("fs");

const CHUNKY_PROJECT = "chunky";   // Modrinth slug; resolved through the normal content path

let active = null;   // { serverId, instanceId, percent, eta, state, log }

function status() {
  if (!active) return { running: false };
  return {
    running: active.state === "running" || active.state === "starting",
    state: active.state,
    percent: active.percent,
    eta: active.eta,
    world: active.world,
    instanceId: active.instanceId,
    serverId: active.serverId,
    lines: active.log.slice(-40),
  };
}

// Parse one console line for Chunky progress. Returns true if it changed state.
function noteLine(line) {
  if (!active) return false;
  active.log.push(line);
  if (active.log.length > 400) active.log.shift();

  if (/\[Chunky\].*Task started/i.test(line)) { active.state = "running"; return true; }

  // "... 12.34% complete ... ETA 0:12:34"
  const pct = /\[Chunky\][^%]*?([\d.]+)%/i.exec(line);
  if (pct) {
    active.percent = Math.max(0, Math.min(100, parseFloat(pct[1])));
    const eta = /ETA[:\s]+([\dhms:.]+)/i.exec(line);
    if (eta) active.eta = eta[1];
    active.state = "running";
    return true;
  }

  if (/\[Chunky\].*Task finished/i.test(line)) {
    active.percent = 100;
    active.state = "done";
    return true;
  }
  return false;
}

// Start a pregeneration run. `deps` injects the server + content engines so
// this module stays free of their wiring.
async function start({ instanceId, radius = 2000, world = "world", deps, onLog, onState }) {
  if (active && (active.state === "running" || active.state === "starting")) {
    throw new Error("A pregeneration run is already going.");
  }
  const inst = deps.getInstance(instanceId);
  if (!inst) throw new Error("Instance not found.");

  const r = Math.max(256, Math.min(20000, Math.round(Number(radius) || 2000)));

  // A server matching this instance's version AND loader, so modded worldgen
  // is what actually runs.
  const platform = inst.loader === "fabric" ? "fabric" : inst.loader === "vanilla" ? "vanilla" : "paper";
  onLog && onLog(`Preparing a ${platform} server for Minecraft ${inst.mcVersion}…`);
  const server = await deps.createServer({
    name: `Pregen — ${inst.name}`,
    platform,
    mcVersion: inst.mcVersion,
  }, { onLog });

  active = { serverId: server.id, instanceId, percent: 0, eta: null, state: "starting", world, log: [] };

  // Chunky has to be present on the SERVER, not the instance.
  onLog && onLog("Installing Chunky into the server…");
  try {
    await deps.installServerMod({ serverId: server.id, project: CHUNKY_PROJECT, loader: platform, mc: inst.mcVersion });
  } catch (e) {
    active.state = "error";
    throw new Error("Couldn't install Chunky: " + e.message);
  }

  await deps.startServer(server.id, {
    onLog: (line) => {
      const changed = noteLine(line);
      onLog && onLog(line);
      if (changed && onState) onState(status());
      // Chunky is driven once the server says it is ready.
      if (/\bDone \([\d.]+s\)!/.test(line)) {
        deps.command(server.id, `chunky world ${world}`);
        deps.command(server.id, "chunky center 0 0");
        deps.command(server.id, "chunky shape square");
        deps.command(server.id, `chunky radius ${r}`);
        deps.command(server.id, "chunky start");
      }
      if (active && active.state === "done") {
        // Stop cleanly so the region files are flushed before we let go.
        deps.command(server.id, "save-all");
        setTimeout(() => { try { deps.stopServer(server.id); } catch { /* already gone */ } }, 4000);
      }
    },
    onState: (st) => {
      if (st.status === "stopped" && active) {
        active.state = active.percent >= 100 ? "done" : "stopped";
        onState && onState(status());
      }
    },
  });

  return status();
}

function stop(deps) {
  if (!active) return { running: false };
  try { deps.stopServer(active.serverId); } catch { /* already stopped */ }
  active.state = "stopped";
  return status();
}

// Where the generated regions ended up, so the UI can say what was produced
// rather than just "finished".
function result(deps) {
  if (!active) return null;
  const dir = deps.serverDir(active.serverId);
  let regions = 0;
  for (const rel of ["world/region", "region"]) {
    try { regions += fs.readdirSync(path.join(dir, rel)).filter((f) => f.endsWith(".mca")).length; }
    catch { /* not this layout */ }
  }
  return { regions, dir };
}

module.exports = { start, stop, status, result, noteLine };
