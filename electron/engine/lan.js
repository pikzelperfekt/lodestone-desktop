// LAN world discovery.
//
// A Minecraft client that has "Open to LAN" enabled announces itself every
// 1.5s to the multicast group 224.0.2.60 on UDP port 4445. The payload is
// plain text: "[MOTD]<motd>[/MOTD][AD]<port>[/AD]". The sender's own address
// gives us the host, so a world becomes joinable as <ip>:<port>.
//
// This is a real listener, not a guess — nothing is reported unless a packet
// actually arrived. It is also entirely passive: it joins a multicast group
// and reads, and never transmits.
const dgram = require("dgram");

const GROUP = "224.0.2.60";
const PORT = 4445;

let socket = null;
let seen = new Map();      // "ip:port" -> { motd, ip, port, lastSeen }
let emit = () => {};

function setEmitter(fn) { emit = fn || (() => {}); }

function parse(text) {
  const motd = /\[MOTD\]([\s\S]*?)\[\/MOTD\]/.exec(text);
  const ad = /\[AD\]([\s\S]*?)\[\/AD\]/.exec(text);
  if (!ad) return null;
  const port = Number(String(ad[1]).trim());
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  // The MOTD carries section-sign colour codes; strip them for display.
  const label = motd ? String(motd[1]).replace(/§./g, "").trim() : "Minecraft LAN world";
  return { motd: label || "Minecraft LAN world", port };
}

function start() {
  if (socket) return { listening: true };
  socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  socket.on("message", (buf, rinfo) => {
    const hit = parse(buf.toString("utf8"));
    if (!hit) return;
    const key = `${rinfo.address}:${hit.port}`;
    const known = seen.has(key);
    seen.set(key, { ...hit, ip: rinfo.address, address: key, lastSeen: Date.now() });
    if (!known) emit("lan:found", seen.get(key));
  });

  socket.on("error", () => { stop(); });

  return new Promise((resolve) => {
    socket.bind(PORT, () => {
      try { socket.addMembership(GROUP); } catch { /* no route to the group */ }
      try { socket.setBroadcast(true); } catch { /* not fatal */ }
      resolve({ listening: true });
    });
  });
}

function stop() {
  if (!socket) return { listening: false };
  try { socket.dropMembership(GROUP); } catch { /* may never have joined */ }
  try { socket.close(); } catch { /* already closed */ }
  socket = null;
  return { listening: false };
}

// Worlds go stale quickly: the announce is every 1.5s, so anything unheard for
// 10s has closed its LAN world or left the network.
function list() {
  const cutoff = Date.now() - 10_000;
  for (const [k, v] of seen) if (v.lastSeen < cutoff) seen.delete(k);
  return { listening: !!socket, worlds: [...seen.values()].sort((a, b) => a.motd.localeCompare(b.motd)) };
}

module.exports = { start, stop, list, setEmitter, parse };
