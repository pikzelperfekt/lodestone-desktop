// Chat + Squads (Vertical C) — group up in squads and message each other live.
//
// Two channel kinds ride the one `messages` table (see 0001_accounts_foundation):
//   - squad channels: channel_id = the squad's uuid; membership gates read/insert.
//   - direct messages: channel_id = the two user uuids sorted and joined "a:b".
// Everything is authenticated through the shared cloud client (cloud.getClient) —
// we never make our own Supabase client — and every call fails soft when the
// backend is unconfigured or the user is signed out, exactly like cloud.status().
//
// Live delivery: one Realtime subscription to INSERTs on `messages`. Postgres
// Changes are RLS-filtered per row against the caller's JWT, so a single
// whole-table subscription only ever delivers rows the user is allowed to read —
// their squads and their DMs — and newly joined squads light up without a
// re-subscribe. Each arrival is enriched with the sender's profile and pushed to
// the renderer on the "cloud:message" channel.
const crypto = require("crypto");
const cloud = require("./cloud");

let emit = () => {};
let channel = null;          // the Realtime subscription (null until subscribed)
let subscribedUserId = null; // whose JWT the current subscription is bound to
const profileCache = new Map(); // id -> profile row (name + skin for rendering senders)

function setEmitter(fn) { emit = fn || (() => {}); }

// A DM channel id is the two participant uuids sorted and joined with a colon, so
// both people independently derive the exact same channel string.
function dmChannelId(a, b) { return [String(a), String(b)].sort().join(":"); }

const PROFILE_COLS = "id, username, display_name, minecraft_uuid, minecraft_name, avatar_url";

// ---- Session guards (fail soft, like cloud.status) -------------------------
async function safeUser() {
  try { return await cloud.currentUser(); } catch { return null; }
}
// For mutations: precise errors — "not configured" vs "not signed in" — never a hang.
async function requireSession() {
  const client = cloud.getClient();          // throws a friendly error when unconfigured
  const user = await cloud.currentUser();
  if (!user) throw new Error("Sign in to your Lodestone account to use squads and chat.");
  return { client, user };
}

// ---- Profile cache ---------------------------------------------------------
function cacheProfiles(list) { for (const p of (list || [])) if (p && p.id) profileCache.set(p.id, p); }
async function cachedProfile(id) {
  if (!id) return null;
  if (profileCache.has(id)) return profileCache.get(id);
  try {
    const { data } = await cloud.getClient().from("profiles").select(PROFILE_COLS).eq("id", id).single();
    if (data) profileCache.set(id, data);
    return data || null;
  } catch { return null; }
}

// The renderer-facing message shape (camelCase + the sender's profile inlined).
function shapeMessage(row, profile) {
  return {
    id: row.id,
    channelType: row.channel_type,
    channelId: row.channel_id,
    sender: row.sender,
    body: row.body,
    createdAt: row.created_at,
    senderProfile: profile || profileCache.get(row.sender) || null,
  };
}

// ---- Realtime subscription -------------------------------------------------
// Idempotent: bring the live channel up for the current user, tear it down when
// signed out, and rebind if the signed-in user changed. Called at the head of
// every signed-in operation so live delivery is always active while the pane is open.
async function ensureSubscribed() {
  const user = await safeUser();
  if (!user) { teardown(); return; }
  if (channel && subscribedUserId === user.id) return;
  teardown();
  let supa;
  try { supa = cloud.getClient(); } catch { return; }
  subscribedUserId = user.id;
  channel = supa
    .channel("lodestone-chat")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, async (payload) => {
      try {
        const row = payload && payload.new;
        if (!row) return;
        const prof = await cachedProfile(row.sender);
        emit("cloud:message", shapeMessage(row, prof));
      } catch { /* one bad row must not kill the stream */ }
    })
    .subscribe();
}
function teardown() {
  if (channel) { try { channel.unsubscribe(); } catch { /* best effort */ } channel = null; }
  subscribedUserId = null;
}

// ---- Squads ----------------------------------------------------------------
// Create a squad and enroll the owner. squads' SELECT policy is member-only, so
// an insert...returning would be filtered out before we've joined; we sidestep
// that by minting the id client-side, inserting bare, joining, then reading it back.
async function createSquad({ name } = {}) {
  const { client, user } = await requireSession();
  const n = (name || "").trim();
  if (!n) throw new Error("Give your squad a name.");
  if (n.length > 80) throw new Error("Squad names are 80 characters max.");
  const id = crypto.randomUUID();
  const { error: sErr } = await client.from("squads").insert({ id, name: n, owner: user.id });
  if (sErr) throw new Error(sErr.message);
  const { error: mErr } = await client.from("squad_members").insert({ squad_id: id, user_id: user.id, role: "owner" });
  if (mErr) throw new Error(mErr.message);
  const { data, error } = await client.from("squads").select("id, name, owner, invite_code, created_at").eq("id", id).single();
  if (error) throw new Error(error.message);
  await ensureSubscribed();
  return { ...data, isOwner: true };
}

// Join by invite code. A prospective member can't SELECT the squad to resolve the
// code (member-only policy), so this goes through the join_squad_by_code
// SECURITY DEFINER RPC (0002) — the same pattern as is_squad_member/is_squad_owner.
async function joinSquad({ inviteCode } = {}) {
  const { client, user } = await requireSession();
  const code = (inviteCode || "").trim().toLowerCase();
  if (!code) throw new Error("Paste an invite code to join a squad.");
  const { data, error } = await client.rpc("join_squad_by_code", { p_code: code });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No squad found for that invite code.");
  await ensureSubscribed();
  return { ...data, isOwner: data.owner === user.id };
}

// Leave a squad. The owner leaving deletes the squad outright (cascading its
// members + messages) rather than orphaning a group no one can administer.
async function leaveSquad({ squadId } = {}) {
  const { client, user } = await requireSession();
  if (!squadId) throw new Error("No squad specified.");
  const { data: squad } = await client.from("squads").select("id, owner").eq("id", squadId).single();
  if (squad && squad.owner === user.id) {
    const { error } = await client.from("squads").delete().eq("id", squadId);
    if (error) throw new Error(error.message);
    await ensureSubscribed();
    return { left: true, deleted: true };
  }
  const { error } = await client.from("squad_members").delete().eq("squad_id", squadId).eq("user_id", user.id);
  if (error) throw new Error(error.message);
  await ensureSubscribed();
  return { left: true, deleted: false };
}

// My squads, each with its full roster joined to profiles.
async function listSquads() {
  const user = await safeUser();
  if (!user) return [];
  await ensureSubscribed();
  const client = cloud.getClient();
  const { data: memberships, error: mErr } = await client.from("squad_members").select("squad_id").eq("user_id", user.id);
  if (mErr) return [];
  const ids = (memberships || []).map((m) => m.squad_id);
  if (!ids.length) return [];
  const [squadsRes, membersRes] = await Promise.all([
    client.from("squads").select("id, name, owner, invite_code, created_at").in("id", ids),
    client.from("squad_members").select("squad_id, user_id, role, joined_at").in("squad_id", ids),
  ]);
  const squads = squadsRes.data || [];
  const members = membersRes.data || [];
  const need = [...new Set(members.map((m) => m.user_id))].filter((id) => id && !profileCache.has(id));
  if (need.length) {
    const { data: profs } = await client.from("profiles").select(PROFILE_COLS).in("id", need);
    cacheProfiles(profs);
  }
  const byId = {};
  for (const s of squads) byId[s.id] = { ...s, isOwner: s.owner === user.id, members: [] };
  for (const m of members) {
    const sq = byId[m.squad_id];
    if (!sq) continue;
    const p = profileCache.get(m.user_id) || { id: m.user_id };
    sq.members.push({ ...p, role: m.role, joined_at: m.joined_at });
  }
  const list = Object.values(byId);
  list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return list;
}

// The invite code for a squad you're in (to hand to a friend).
async function squadInvite({ squadId } = {}) {
  const { client } = await requireSession();
  if (!squadId) throw new Error("No squad specified.");
  const { data, error } = await client.from("squads").select("id, name, invite_code").eq("id", squadId).single();
  if (error) throw new Error(error.message);
  return { squadId: data.id, name: data.name, inviteCode: data.invite_code };
}

// ---- Direct messages -------------------------------------------------------
// Open (or resume) a DM with someone: derive the shared channel id and resolve
// their profile. No row is written until the first message is sent.
async function startDm({ userId } = {}) {
  const { user } = await requireSession();
  const other = (userId || "").trim();
  if (!other) throw new Error("Pick someone to message.");
  if (other === user.id) throw new Error("You can't message yourself.");
  const channelId = dmChannelId(user.id, other);
  const partner = await cachedProfile(other);
  await ensureSubscribed();
  return { channelId, partner: partner || { id: other } };
}

// My DM conversations, newest first, each collapsed to its latest message + partner.
async function listDMs() {
  const user = await safeUser();
  if (!user) return [];
  await ensureSubscribed();
  const client = cloud.getClient();
  const { data, error } = await client.from("messages")
    .select("channel_id, sender, body, created_at")
    .eq("channel_type", "dm")
    .order("id", { ascending: false })
    .limit(300);
  if (error) return [];
  const latest = new Map(); // channel_id -> most-recent row
  for (const row of (data || [])) if (!latest.has(row.channel_id)) latest.set(row.channel_id, row);
  const partnerOf = (cid) => { const [a, b] = cid.split(":"); return a === user.id ? b : a; };
  const need = [...latest.keys()].map(partnerOf).filter((id) => id && !profileCache.has(id));
  if (need.length) {
    const { data: profs } = await client.from("profiles").select(PROFILE_COLS).in("id", need);
    cacheProfiles(profs);
  }
  const out = [];
  for (const [cid, row] of latest) {
    const pid = partnerOf(cid);
    out.push({ channelId: cid, partner: profileCache.get(pid) || { id: pid }, lastBody: row.body, lastAt: row.created_at });
  }
  out.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
  return out;
}

// ---- Messages --------------------------------------------------------------
// Chronological history for a channel (the newest `limit`, oldest-first for display).
async function history({ channelType, channelId, limit } = {}) {
  const user = await safeUser();
  if (!user) return [];
  if (!channelType || !channelId) return [];
  await ensureSubscribed();
  const client = cloud.getClient();
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const { data, error } = await client.from("messages")
    .select("id, channel_type, channel_id, sender, body, created_at")
    .eq("channel_type", channelType)
    .eq("channel_id", channelId)
    .order("id", { ascending: false })
    .limit(lim);
  if (error) throw new Error(error.message);
  const rows = (data || []).slice().reverse();
  const need = [...new Set(rows.map((r) => r.sender))].filter((id) => id && !profileCache.has(id));
  if (need.length) {
    const { data: profs } = await client.from("profiles").select(PROFILE_COLS).in("id", need);
    cacheProfiles(profs);
  }
  return rows.map((r) => shapeMessage(r, profileCache.get(r.sender)));
}

// Send a message; returns the stored row (shaped) so the UI can echo it instantly.
// Realtime also delivers it, so the renderer dedupes by message id.
async function send({ channelType, channelId, body } = {}) {
  const { client, user } = await requireSession();
  if (!channelType || !channelId) throw new Error("No channel selected.");
  const text = (body || "").trim();
  if (!text) throw new Error("Type a message first.");
  if (text.length > 4000) throw new Error("That message is too long (4000 characters max).");
  await ensureSubscribed();
  const { data, error } = await client.from("messages")
    .insert({ channel_type: channelType, channel_id: channelId, sender: user.id, body: text })
    .select("id, channel_type, channel_id, sender, body, created_at")
    .single();
  if (error) throw new Error(error.message);
  let mine = profileCache.get(user.id);
  if (!mine) { try { mine = await cloud.getProfile(); if (mine) profileCache.set(user.id, mine); } catch { /* fall back to id */ } }
  return shapeMessage(data, mine);
}

module.exports = {
  setEmitter, dmChannelId,
  createSquad, joinSquad, leaveSquad, listSquads, squadInvite,
  startDm, listDMs,
  history, send,
};
