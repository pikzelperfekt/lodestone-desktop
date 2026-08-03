// Shared packs — one permanent code, live propagation.
//
// THE BUG THIS REPLACES
// share.js encodes the pack manifest itself into the "share code", so the code
// changed every time a mod changed, and a friend holding an old code held a
// dead snapshot with no route back to the owner. Sharing was a one-shot copy
// wearing the language of a subscription.
//
// THE MODEL
// A shared pack is a durable row with a code that never changes. Each member
// keeps their OWN local instance mirroring it — nobody reads anyone else's
// instance. Whoever makes a change publishes a new manifest; every other
// member's client receives it over Realtime and applies it through the exact
// same reconcile path a pasted code would take (share.syncInstance). Separate
// installs that stay identical, which is what "shared" should feel like.
//
// WHO MAY PUBLISH is the pack's `mode`:
//   'owner'    — only the owner's edits propagate (a hosted modpack)
//   'everyone' — any member may publish (a pack the group maintains together)
// Enforced by RLS in 0003, not merely in the UI: the anon key is public, so a
// client-side check would be decorative.
const fs = require("fs");
const path = require("path");
const cloud = require("./cloud");
const share = require("./share");

let store = null;      // { getInstance, listInstances, syncFromCode, createFromCode }
let emit = () => {};
let channel = null;
let DATA_DIR = null;
let applying = false;  // reentrancy guard: applying an update must not re-publish

function init({ dataDir, store: s }) { DATA_DIR = dataDir; store = s || null; }
function setEmitter(fn) { emit = fn || (() => {}); }

// ---- Local link table -------------------------------------------------------
// Maps localInstanceId <-> packId, plus the last revision we applied. Kept on
// disk (not only in the DB) so an offline launch still knows an instance is
// shared, and so we can ignore the echo of our own publish.
function linkFile() { return path.join(DATA_DIR, "shared-packs.json"); }
function readLinks() {
  try { const j = JSON.parse(fs.readFileSync(linkFile(), "utf8")); return Array.isArray(j) ? j : []; }
  catch { return []; }
}
function writeLinks(list) {
  try { fs.writeFileSync(linkFile(), JSON.stringify(list, null, 2)); } catch { /* cosmetic */ }
}
function linkFor(instanceId) { return readLinks().find((l) => l.instanceId === instanceId) || null; }
function linkForPack(packId) { return readLinks().find((l) => l.packId === packId) || null; }
function upsertLink(link) {
  const list = readLinks();
  const i = list.findIndex((l) => l.packId === link.packId);
  if (i >= 0) list[i] = { ...list[i], ...link }; else list.push(link);
  writeLinks(list);
}
function dropLink(packId) { writeLinks(readLinks().filter((l) => l.packId !== packId)); }

// ---- Plumbing ---------------------------------------------------------------
async function session() {
  let supa;
  try { supa = cloud.getClient(); } catch { return { supa: null, me: null }; }
  let me = null;
  try { me = await cloud.currentUser(); } catch { me = null; }
  return { supa, me };
}

async function need() {
  const { supa, me } = await session();
  if (!supa) throw new Error("Cloud isn't set up yet — see SETUP.md.");
  if (!me) throw new Error("Sign in to your Lodestone account to share packs.");
  return { supa, me };
}

// Human-shaped, unambiguous code: no O/0/I/1, grouped for reading aloud.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function mintCode() {
  const pick = (n) => Array.from({ length: n }, () =>
    ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
  return `LODE-${pick(4)}-${pick(4)}`;
}

function mapPack(r, links) {
  if (!r) return null;
  const link = (links || readLinks()).find((l) => l.packId === r.id) || null;
  const manifest = r.manifest && typeof r.manifest === "object" ? r.manifest : {};
  return {
    id: r.id,
    code: r.code,
    owner: r.owner,
    name: r.name,
    mcVersion: r.mc_version,
    loader: r.loader,
    mode: r.mode,
    revision: Number(r.revision) || 1,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    modCount: Array.isArray(manifest.mods) ? manifest.mods.length : 0,
    instanceId: link ? link.instanceId : null,
    manifest,
  };
}

// ---- Owner: turn a local instance into a shared pack ------------------------
async function createShare({ instanceId, mode = "owner" }) {
  const { supa, me } = await need();
  const inst = store && store.getInstance(instanceId);
  if (!inst) throw new Error("Instance not found.");
  const existing = linkFor(instanceId);
  if (existing) throw new Error("That instance is already shared. Copy its existing code.");

  const def = share.packDef(inst);
  // Retry on the (astronomically unlikely) code collision rather than failing
  // the user's action on a unique-violation.
  let row = null, lastErr = null;
  for (let attempt = 0; attempt < 5 && !row; attempt++) {
    const { data, error } = await supa.from("shared_packs").insert({
      owner: me.id,
      code: mintCode(),
      name: def.name,
      mc_version: def.mcVersion,
      loader: def.loader,
      manifest: def,
      mode: mode === "everyone" ? "everyone" : "owner",
      updated_by: me.id,
    }).select("*").single();
    if (!error) { row = data; break; }
    lastErr = error;
    if (!/duplicate key|unique/i.test(error.message || "")) break;
  }
  if (!row) throw new Error(lastErr ? lastErr.message : "Couldn't create the shared pack.");

  // The owner is a member too, so realtime + member lists treat them uniformly.
  await supa.from("shared_pack_members")
    .insert({ pack_id: row.id, member: me.id, client_instance_id: instanceId });

  upsertLink({ packId: row.id, instanceId, revision: Number(row.revision) || 1 });
  await start();
  const mapped = mapPack(row);
  emit("pack:shared", mapped);
  return mapped;
}

// ---- Follower: join an existing pack by its permanent code -------------------
async function joinByCode(code) {
  const { supa } = await need();
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) throw new Error("Paste a share code first.");

  // The SELECT policy is member-only, so resolving the code has to go through
  // the SECURITY DEFINER RPC — the same shape as join_squad_by_code.
  const { data, error } = await supa.rpc("join_pack_by_code", { p_code: clean, p_client_instance_id: null });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("No shared pack found for that code.");

  // Already mirroring it? Just reconcile instead of making a second copy.
  const existing = linkForPack(row.id);
  if (existing) {
    await applyToInstance(row, existing.instanceId);
    return mapPack(row);
  }

  const created = await store.createFromCode(share.encodeCode(normalizeDef(row)));
  const instanceId = created && created.instance ? created.instance.id : null;
  if (instanceId) {
    upsertLink({ packId: row.id, instanceId, revision: Number(row.revision) || 1 });
    await supa.from("shared_pack_members")
      .update({ client_instance_id: instanceId })
      .eq("pack_id", row.id);
  }
  await start();
  const mapped = mapPack(row);
  emit("pack:joined", mapped);
  return mapped;
}

function normalizeDef(row) {
  const m = row.manifest && typeof row.manifest === "object" ? row.manifest : {};
  return {
    name: m.name || row.name || "Shared pack",
    loader: m.loader || row.loader || "vanilla",
    mcVersion: m.mcVersion || row.mc_version || "",
    mods: Array.isArray(m.mods) ? m.mods : [],
  };
}

// ---- Publish: my local change becomes everyone's ----------------------------
// Called explicitly, and automatically by index.js whenever an instance's
// content changes. Silent no-op for instances that aren't shared, so the
// content paths can call it unconditionally.
async function publish(instanceId, { silent = true } = {}) {
  const link = linkFor(instanceId);
  if (!link) return null;
  if (applying) return null;                 // don't echo an update we just applied

  let supa, me;
  try { ({ supa, me } = await need()); }
  catch (e) { if (silent) return null; throw e; }

  const inst = store && store.getInstance(instanceId);
  if (!inst) return null;
  const def = share.packDef(inst);

  const { data, error } = await supa.from("shared_packs")
    .update({
      name: def.name,
      mc_version: def.mcVersion,
      loader: def.loader,
      manifest: def,
      revision: (Number(link.revision) || 1) + 1,
      updated_by: me.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", link.packId)
    .select("*")
    .single();

  if (error) {
    // RLS refusing the write is the expected outcome for a member of an
    // owner-only pack. Surface it as guidance, never as a crash.
    const denied = /row-level security/i.test(error.message || "");
    const msg = denied
      ? "Only the pack owner can change this shared pack."
      : error.message;
    if (silent) { emit("pack:error", { instanceId, message: msg }); return null; }
    throw new Error(msg);
  }

  upsertLink({ packId: link.packId, instanceId, revision: Number(data.revision) || 1 });
  const mapped = mapPack(data);
  emit("pack:published", mapped);
  return mapped;
}

// ---- Receive: apply someone else's change to my copy ------------------------
async function applyToInstance(row, instanceId) {
  const inst = store && store.getInstance(instanceId);
  if (!inst) return;
  applying = true;
  try {
    const summary = await store.syncFromCode({ id: instanceId, code: share.encodeCode(normalizeDef(row)) });
    upsertLink({ packId: row.id, instanceId, revision: Number(row.revision) || 1 });
    emit("pack:applied", {
      packId: row.id, instanceId, name: row.name,
      added: summary ? summary.added : 0,
      removed: summary ? summary.removed : 0,
      revision: Number(row.revision) || 1,
    });
  } catch (e) {
    emit("pack:error", { instanceId, message: e.message });
  } finally {
    applying = false;
  }
}

// ---- Reads ------------------------------------------------------------------
async function listShares() {
  const { supa, me } = await session();
  if (!supa || !me) return [];
  const { data, error } = await supa.from("shared_packs").select("*").order("updated_at", { ascending: false });
  if (error) return [];
  const links = readLinks();
  return (data || []).map((r) => mapPack(r, links));
}

async function statusFor(instanceId) {
  const link = linkFor(instanceId);
  if (!link) return { shared: false };
  const { supa } = await session();
  if (!supa) return { shared: true, offline: true, packId: link.packId };
  const { data, error } = await supa.from("shared_packs").select("*").eq("id", link.packId).maybeSingle();
  if (error || !data) return { shared: true, offline: true, packId: link.packId };
  const { me } = await session();
  const mapped = mapPack(data, [link]);
  return { shared: true, ...mapped, isOwner: !!(me && data.owner === me.id) };
}

async function setMode({ packId, mode }) {
  const { supa } = await need();
  const { data, error } = await supa.from("shared_packs")
    .update({ mode: mode === "everyone" ? "everyone" : "owner" })
    .eq("id", packId).select("*").single();
  if (error) throw new Error(/row-level security/i.test(error.message) ? "Only the pack owner can change who may edit." : error.message);
  return mapPack(data);
}

async function inviteFriend({ packId, memberId }) {
  const { supa } = await need();
  const { error } = await supa.rpc("invite_to_pack", { p_pack: packId, p_member: memberId });
  if (error) throw new Error(error.message);
  return true;
}

async function members(packId) {
  const { supa } = await session();
  if (!supa) return [];
  const { data, error } = await supa.from("shared_pack_members")
    .select("member, joined_at, profiles:member (username, display_name, minecraft_name)")
    .eq("pack_id", packId);
  if (error) return [];
  return data || [];
}

// Stop mirroring. The owner deleting the row unshares it for everyone; a
// member only removes themselves.
async function leave(packId) {
  const { supa, me } = await need();
  const { data } = await supa.from("shared_packs").select("owner").eq("id", packId).maybeSingle();
  if (data && data.owner === me.id) await supa.from("shared_packs").delete().eq("id", packId);
  else await supa.from("shared_pack_members").delete().eq("pack_id", packId).eq("member", me.id);
  dropLink(packId);
  emit("pack:left", { packId });
  return true;
}

// ---- Realtime ---------------------------------------------------------------
async function start() {
  const { supa, me } = await session();
  if (!supa || !me) return;
  stop();
  channel = supa
    .channel("lodestone:shared-packs")
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "shared_packs" }, async (payload) => {
      const row = payload.new;
      if (!row) return;
      const link = linkForPack(row.id);
      if (!link) return;                                  // not a pack we mirror
      if (row.updated_by === me.id) {                     // our own write echoing back
        upsertLink({ packId: row.id, instanceId: link.instanceId, revision: Number(row.revision) || 1 });
        return;
      }
      if ((Number(row.revision) || 1) <= (Number(link.revision) || 0)) return;  // already applied
      await applyToInstance(row, link.instanceId);
    })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "shared_packs" }, (payload) => {
      const id = payload.old && payload.old.id;
      if (id && linkForPack(id)) { dropLink(id); emit("pack:left", { packId: id }); }
    })
    .subscribe();
}

function stop() {
  if (channel) { try { channel.unsubscribe(); } catch { /* best effort */ } channel = null; }
}

// On boot, pull anything that changed while we were closed. Realtime only
// covers the window where we're actually connected.
async function catchUp() {
  const links = readLinks();
  if (!links.length) return;
  const { supa, me } = await session();
  if (!supa || !me) return;
  const { data, error } = await supa.from("shared_packs").select("*").in("id", links.map((l) => l.packId));
  if (error || !data) return;
  for (const row of data) {
    const link = links.find((l) => l.packId === row.id);
    if (!link) continue;
    if ((Number(row.revision) || 1) > (Number(link.revision) || 0) && row.updated_by !== me.id) {
      await applyToInstance(row, link.instanceId);
    }
  }
}

module.exports = {
  init, setEmitter, createShare, joinByCode, publish, listShares, statusFor,
  setMode, inviteFriend, members, leave, start, stop, catchUp, linkFor,
};
