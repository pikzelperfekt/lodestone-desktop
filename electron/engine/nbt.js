// [wave0] Minimal NBT (Named Binary Tag) reader/writer — the Node mirror of
// LodestoneCore's NBT.swift, scoped to what world rename needs: parse a full
// level.dat tree (all 12 tag types, big-endian Java layout), replace one
// TAG_String (Data→LevelName), and re-serialize with every other byte intact.
//
// Byte fidelity: scalar / string / byte-array / int-array / long-array payloads
// are kept as raw slices (never decoded + re-encoded), so Java's modified UTF-8
// strings and exact float bits round-trip untouched. Only compound and list
// framing is rebuilt — and the string we deliberately replace. Because a
// TAG_String is length-prefixed, replacement rebuilds the byte stream (payload =
// fresh u16 length + UTF-8 bytes), never a same-length splice.
// No dependencies.

const T = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
  BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12,
};
const SCALAR_SIZE = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 4, 6: 8 };

// ---- Reader ----
// Node shapes:
//   { tag, raw }                 — payload kept as the exact original bytes
//   { tag: 10, pairs: [[nameBuf, node], …] }   — compound, order preserved
//   { tag: 9, elemTag, items: [node] }         — list of compounds/lists
function makeReader(buf) {
  let i = 0;
  const need = (n) => { if (i + n > buf.length) throw new Error("NBT: truncated"); };
  return {
    u8() { need(1); return buf[i++]; },
    u16() { need(2); const v = buf.readUInt16BE(i); i += 2; return v; },
    i32() { need(4); const v = buf.readInt32BE(i); i += 4; return v; },
    slice(n) { need(n); const s = buf.subarray(i, i + n); i += n; return s; },
    mark() { return i; },
    from(start) { return buf.subarray(start, i); },
    done() { return i >= buf.length; },
  };
}

function readPayload(r, tag) {
  if (SCALAR_SIZE[tag]) return { tag, raw: r.slice(SCALAR_SIZE[tag]) };
  switch (tag) {
    case T.STRING: {
      const start = r.mark();
      const n = r.u16(); r.slice(n);
      return { tag, raw: r.from(start) };
    }
    case T.BYTE_ARRAY: case T.INT_ARRAY: case T.LONG_ARRAY: {
      const start = r.mark();
      const n = r.i32();
      const unit = tag === T.BYTE_ARRAY ? 1 : tag === T.INT_ARRAY ? 4 : 8;
      r.slice(Math.max(0, n) * unit);
      return { tag, raw: r.from(start) };
    }
    case T.LIST: return readList(r);
    case T.COMPOUND: return readCompound(r);
    default: throw new Error("NBT: bad tag " + tag);
  }
}

function readCompound(r) {
  const pairs = [];
  for (;;) {
    const t = r.u8();
    if (t === T.END) break;
    const name = r.slice(r.u16());   // raw key bytes — compared, never re-decoded
    pairs.push([name, readPayload(r, t)]);
  }
  return { tag: T.COMPOUND, pairs };
}

function readList(r) {
  const start = r.mark();
  const elemTag = r.u8();
  const count = r.i32();
  // Lists needing recursion (nested compounds/lists) are parsed into items;
  // everything else is scanned to its end and kept as one raw slice.
  if (count > 0 && (elemTag === T.COMPOUND || elemTag === T.LIST)) {
    const items = [];
    for (let k = 0; k < count; k++) items.push(readPayload(r, elemTag));
    return { tag: T.LIST, elemTag, items };
  }
  for (let k = 0; k < Math.max(0, count); k++) {
    if (SCALAR_SIZE[elemTag]) r.slice(SCALAR_SIZE[elemTag]);
    else if (elemTag === T.STRING) r.slice(r.u16());
    else if (elemTag === T.BYTE_ARRAY) r.slice(Math.max(0, r.i32()));
    else if (elemTag === T.INT_ARRAY) r.slice(Math.max(0, r.i32()) * 4);
    else if (elemTag === T.LONG_ARRAY) r.slice(Math.max(0, r.i32()) * 8);
    else throw new Error("NBT: bad list element tag " + elemTag);
  }
  return { tag: T.LIST, raw: r.from(start) };
}

/** Parse a gunzipped NBT stream. Root must be a named compound (level.dat is). */
function parse(buf) {
  const r = makeReader(buf);
  if (r.u8() !== T.COMPOUND) throw new Error("NBT: root is not a compound");
  const rootName = r.slice(r.u16());
  return { rootName, root: readCompound(r) };
}

// ---- Writer ----
function u8b(v) { return Buffer.from([v]); }
function u16b(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; }
function i32b(v) { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; }

function writeNode(node, out) {
  if (node.raw) { out.push(node.raw); return; }
  if (node.tag === T.COMPOUND) {
    for (const [name, child] of node.pairs) {
      out.push(u8b(child.tag), u16b(name.length), name);
      writeNode(child, out);
    }
    out.push(u8b(T.END));
    return;
  }
  if (node.tag === T.LIST) {
    out.push(u8b(node.elemTag), i32b(node.items.length));
    for (const item of node.items) writeNode(item, out);
    return;
  }
  throw new Error("NBT: unwritable node");
}

/** Serialize back to the (uncompressed) NBT byte stream. */
function write(rootName, root) {
  const out = [u8b(T.COMPOUND), u16b(rootName.length), rootName];
  writeNode(root, out);
  return Buffer.concat(out);
}

// ---- Helpers scoped to the LevelName edit ----
function getChild(compound, key) {
  if (!compound || compound.tag !== T.COMPOUND) return null;
  const k = Buffer.from(key, "utf8");
  const pair = compound.pairs.find(([name]) => name.equals(k));
  return pair ? pair[1] : null;
}

/** Set `key` on a compound to a TAG_String with `value` (replace or append). */
function setString(compound, key, value) {
  if (!compound || compound.tag !== T.COMPOUND) throw new Error("NBT: not a compound");
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.length > 0xffff) throw new Error("NBT: string too long");
  const node = { tag: T.STRING, raw: Buffer.concat([u16b(bytes.length), bytes]) };
  const k = Buffer.from(key, "utf8");
  const pair = compound.pairs.find(([name]) => name.equals(k));
  if (pair) pair[1] = node;
  else compound.pairs.push([k, node]);
}

/** Decode a TAG_String node's text (UTF-8; enough for display + tests). */
function readString(node) {
  if (!node || node.tag !== T.STRING || !node.raw) return null;
  return node.raw.subarray(2).toString("utf8");
}

module.exports = { parse, write, getChild, setString, readString, TAGS: T };
