// Live performance stats while the game runs.
//
// Ported from LodestoneCore/Performance/LiveStatsParser.swift + the host-memory
// half of the Mac's LiveStatsOverlay.
//
// Minecraft doesn't print FPS to its log on its own — common diagnostic mods do
// (Spark summaries, F3 screenshots, debug builds), in either `fps: 142` or
// `142 fps` shape. Both are accepted and clamped to 1…1000 so a version string
// or a coordinate can't masquerade as a frame rate. When one line carries more
// than one reading the LAST wins: it's the freshest.
const os = require("os");

const FPS_PATTERNS = [
  /fps[:=]?\s*(\d{1,4})\b/gi,
  /\b(\d{1,4})\s*fps\b/gi,
];

function fpsFromLine(line) {
  const text = String(line || "");
  let latest = null;
  for (const re of FPS_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v >= 1 && v <= 1000) latest = v;
    }
  }
  return latest;
}

// The JVM heap "used" fraction (0…1) off an F3-style `Mem: 47% 1523/3276MB`
// line. The explicit percentage is trusted first; the MB pair is the fallback,
// so a weird or missing percent still yields a value.
function memoryFractionFromLine(line) {
  const text = String(line || "");
  if (!/mem/i.test(text)) return null;

  const pct = /(\d{1,3})\s*%/.exec(text);
  if (pct) {
    const v = Number(pct[1]) / 100;
    if (Number.isFinite(v)) return Math.max(0, Math.min(1, v));
  }
  const pair = /(\d{1,7})\s*\/\s*(\d{1,7})\s*MB/i.exec(text);
  if (pair) {
    const used = Number(pair[1]), total = Number(pair[2]);
    if (Number.isFinite(used) && Number.isFinite(total) && total > 0) {
      return Math.max(0, Math.min(1, used / total));
    }
  }
  return null;
}

// Host RAM in GB. This is the machine's memory, not the JVM heap — the Mac
// overlay shows the same thing beside the frame rate.
function hostMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    usedGB: (total - free) / 1073741824,
    totalGB: total / 1073741824,
  };
}

module.exports = { fpsFromLine, memoryFractionFromLine, hostMemory };
