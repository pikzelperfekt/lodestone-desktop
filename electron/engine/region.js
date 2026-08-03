// Minecraft region (.mca) reader — enough of it to draw a biome map and count
// what a world contains. The Node counterpart of the Mac's RegionReader.
//
// FORMAT
//   An .mca is a 8KiB header then 4KiB sectors. The header is 1024 location
//   entries (3-byte big-endian sector offset + 1-byte sector count) followed by
//   1024 timestamps. A chunk starts at offset*4096 with a 4-byte length, a
//   1-byte compression id (1 gzip, 2 zlib, 3 raw), then the NBT payload.
//
// ⚠️ THE TRAP THAT PRODUCES CONVINCING GARBAGE: filter chunks to
// Status == "minecraft:full". Roughly half the chunks in a save are
// proto-chunks (structure_starts / biomes / carvers / initialize_light) whose
// biome arrays are PLACEHOLDERS — every cell reads minecraft:plains. That
// looks like real data and scores about 1.5% against the actual world. On the
// Mac side this exact mistake produced a "cubiomes is broken" result that was
// nothing of the sort.
//
// Biome storage since 1.16: each section holds a palette plus a long array of
// indices at bits = max(1, ceil(log2(palette.length))), packed WITHOUT spanning
// longs — indices never straddle a 64-bit boundary, so the last few bits of
// each long are simply unused.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const nbt = require("./nbt");

const T = nbt.TAGS;

const child = (c, name) => {
  if (!c || c.tag !== T.COMPOUND) return null;
  const hit = c.pairs.find(([k]) => k.toString("utf8") === name);
  return hit ? hit[1] : null;
};
const asString = (n) => (n && n.tag === T.STRING ? n.raw.subarray(2).toString("utf8") : null);
const asInt = (n) => (n && n.tag === T.INT ? n.raw.readInt32BE(0) : null);

// nbt.js keeps a list of scalars/strings as ONE raw slice rather than parsed
// items (only compound/list elements get recursed into), so a biome palette
// has to be decoded here. Layout: u8 elemTag, i32 count, then count entries of
// u16 length + UTF-8 bytes.
function stringList(n) {
  if (!n || n.tag !== T.LIST) return [];
  if (Array.isArray(n.items)) return n.items.map((x) => asString(x)).filter(Boolean);
  const raw = n.raw;
  if (!raw || raw.length < 5) return [];
  if (raw.readUInt8(0) !== T.STRING) return [];
  const count = raw.readInt32BE(1);
  const out = [];
  let i = 5;
  for (let k = 0; k < count && i + 2 <= raw.length; k++) {
    const len = raw.readUInt16BE(i); i += 2;
    if (i + len > raw.length) break;
    out.push(raw.toString("utf8", i, i + len));
    i += len;
  }
  return out;
}

function longArray(n) {
  if (!n || n.tag !== T.LONG_ARRAY) return null;
  const len = n.raw.readInt32BE(0);
  const out = new Array(len);
  for (let i = 0; i < len; i++) out[i] = n.raw.readBigInt64BE(4 + i * 8);
  return out;
}

// Unpack the non-spanning packed indices used since 1.16.
function unpack(longs, bits, count) {
  const out = new Array(count).fill(0);
  if (!longs || !longs.length || bits <= 0) return out;
  const perLong = Math.floor(64 / bits);
  const mask = (1n << BigInt(bits)) - 1n;
  let i = 0;
  for (const word of longs) {
    for (let s = 0; s < perLong && i < count; s++, i++) {
      out[i] = Number((word >> BigInt(s * bits)) & mask);
    }
    if (i >= count) break;
  }
  return out;
}

function decompress(buf, kind) {
  if (kind === 1) return zlib.gunzipSync(buf);
  if (kind === 2) return zlib.inflateSync(buf);
  return buf;                                     // 3 = uncompressed
}

// Walk one region file, calling back with each FULL chunk's parsed NBT root.
function eachChunk(file, fn) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch { return; }
  try {
    const header = Buffer.alloc(4096);
    if (fs.readSync(fd, header, 0, 4096, 0) < 4096) return;
    for (let i = 0; i < 1024; i++) {
      const off = (header.readUInt8(i * 4) << 16) | (header.readUInt8(i * 4 + 1) << 8) | header.readUInt8(i * 4 + 2);
      const sectors = header.readUInt8(i * 4 + 3);
      if (!off || !sectors) continue;             // chunk never generated
      const head = Buffer.alloc(5);
      if (fs.readSync(fd, head, 0, 5, off * 4096) < 5) continue;
      const len = head.readUInt32BE(0);
      if (len <= 1 || len > sectors * 4096) continue;
      const body = Buffer.alloc(len - 1);
      if (fs.readSync(fd, body, 0, len - 1, off * 4096 + 5) < len - 1) continue;
      let raw;
      try { raw = decompress(body, head.readUInt8(4)); } catch { continue; }
      let root;
      try { root = nbt.parse(raw).root; } catch { continue; }
      // Only fully generated chunks carry real biome data.
      if (asString(child(root, "Status")) !== "minecraft:full") continue;
      fn(root, i);
    }
  } finally { try { fs.closeSync(fd); } catch { /* already gone */ } }
}

// Scan a dimension's region folder and return a biome histogram plus a
// coarse top-down biome grid (one cell per chunk) for the map.
function scanDimension({ regionDir, maxRegions = 64 }) {
  let files = [];
  try { files = fs.readdirSync(regionDir).filter((f) => /^r\.-?\d+\.-?\d+\.mca$/.test(f)); } catch { return null; }
  if (!files.length) return null;
  files = files.slice(0, maxRegions);

  const counts = new Map();        // biome name -> cells
  const cells = [];                // { x, z, biome } per chunk, chunk coords
  let chunks = 0;

  for (const f of files) {
    const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(f);
    const rx = Number(m[1]), rz = Number(m[2]);
    eachChunk(path.join(regionDir, f), (root, index) => {
      chunks++;
      const cx = rx * 32 + (index % 32);
      const cz = rz * 32 + Math.floor(index / 32);
      const sections = child(root, "sections");
      if (!sections || sections.tag !== T.LIST) return;

      // Tally every biome cell in the chunk, and remember the most common one
      // as the chunk's colour for the map.
      const local = new Map();
      for (const sec of sections.items) {
        const biomes = child(sec, "biomes");
        if (!biomes) continue;
        const palNode = child(biomes, "palette");
        if (!palNode || palNode.tag !== T.LIST) continue;
        const palette = stringList(palNode);
        if (!palette.length) continue;
        if (palette.length === 1) {
          local.set(palette[0], (local.get(palette[0]) || 0) + 64);
          counts.set(palette[0], (counts.get(palette[0]) || 0) + 64);
          continue;
        }
        const bits = Math.max(1, 32 - Math.clz32(palette.length - 1));
        const idx = unpack(longArray(child(biomes, "data")), bits, 64);
        for (const v of idx) {
          const name = palette[v] || palette[0];
          local.set(name, (local.get(name) || 0) + 1);
          counts.set(name, (counts.get(name) || 0) + 1);
        }
      }
      let top = null, topN = -1;
      for (const [name, n] of local) if (n > topN) { top = name; topN = n; }
      if (top) cells.push({ x: cx, z: cz, biome: top });
    });
  }

  const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  const biomes = [...counts.entries()]
    .map(([name, n]) => ({ name, cells: n, share: n / total }))
    .sort((a, b) => b.cells - a.cells);

  return { chunks, biomes, cells, regionsScanned: files.length, regionsTotal: files.length };
}

module.exports = { scanDimension, eachChunk };
