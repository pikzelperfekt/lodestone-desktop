// Tiny networking + download helpers (sha1-verified, skip-existing), used by the
// install pipeline. Pure Node — identical on Windows/macOS/Linux.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const UA = { "User-Agent": "Lodestone/0.1 (prototype)" };

async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers } });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json();
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha1");
    const s = fs.createReadStream(file);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

// Download `url` → `dest`, skipping when an existing file already matches (by sha1
// when known, else by non-zero size).
async function download(url, dest, sha1) {
  try {
    if (fs.existsSync(dest)) {
      if (sha1) { if ((await sha1File(dest)) === sha1) return false; }
      else if (fs.statSync(dest).size > 0) return false;
    }
  } catch {}
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`download ${url} → ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return true;
}

// Run async `fn` over `items` with a concurrency cap, reporting progress.
async function pool(items, limit, fn, onProgress) {
  let done = 0;
  const total = items.length;
  const queue = items.slice();
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      try { await fn(item); } catch (e) { /* tolerant: skip a dead asset */ }
      done++;
      if (onProgress) onProgress(done, total);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, total) }, worker));
}

module.exports = { getJSON, download, sha1File, pool };
