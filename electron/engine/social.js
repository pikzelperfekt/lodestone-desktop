// Vertical B — Friends + Presence.
//
// Builds on the accounts substrate in cloud.js. Two halves:
//   1. Friends: request / accept / remove / block over the `friendships` table
//      (a directional requester -> addressee row; "my friends" = accepted rows
//      I'm on either side of). People search reuses cloud.searchProfiles.
//   2. Presence: who's online and what they're doing. This is EPHEMERAL — it
//      rides Supabase Realtime Presence on a shared channel, not a table. Only
//      the durable half (profiles.last_seen_at) is persisted, on an interval.
//
// Live pushes go to the renderer via emit():
//   - "cloud:friends"  after any change to a friendship I'm in (Realtime on the
//     `friendships` table), carrying the full recomputed friends/requests lists.
//   - "cloud:presence" whenever the presence roster syncs, carrying { online }.
//
// Everything fails SOFT when the cloud is unconfigured or signed out: reads
// return empty shapes, mutations throw a clean "sign in" error, and nothing
// hangs or keeps a channel open. Presence auto-starts on sign-in and tears down
// on sign-out via the shared client's auth listener.
const cloud = require("./cloud");

// Profile columns friends/requests rows are hydrated with (names + skin source).
const PROFILE_FIELDS =
  "id, username, display_name, minecraft_uuid, minecraft_name, avatar_url, last_seen_at";
const PRESENCE_CHANNEL = "lodestone-presence";
const DEFAULT_ACTIVITY = "In launcher";
const LAST_SEEN_MS = 60 * 1000;

let emit = () => {};
let started = false;
let me = null;               // my user id while a presence session is live
let myProfile = null;        // cached profile for the presence payload
let presenceCh = null;       // Realtime Presence channel (ephemeral roster)
let friendsCh = null;        // Realtime postgres_changes on `friendships`
let lastSeenTimer = null;    // interval bumping profiles.last_seen_at
let currentActivity = DEFAULT_ACTIVITY;

function setEmitter(fn) { emit = fn || (() => {}); }

// The authenticated Supabase client, or null when unconfigured (fail soft).
function client() {
  try { return cloud.getClient(); } catch { return null; }
}
function requireClient() {
  const c = client();
  if (!c) throw new Error("Sign in to Lodestone to use friends.");
  return c;
}
async function myId() {
  const user = await cloud.currentUser();
  return user ? user.id : null;
}
async function requireUser() {
  const uid = await myId();
  if (!uid) throw new Error("Sign in to Lodestone to use friends.");
  return uid;
}
const emptyFriends = () => ({ friends: [], incoming: [], outgoing: [], blocked: [] });
const nameOf = (u) => (u && (u.display_name || u.username || u.minecraft_name)) || "Player";

// ---- Lifecycle: presence + friendships realtime follow the auth session ------
// Called once from engine.init after cloud.init. Registers an auth listener so
// presence tracking starts on sign-in and tears down on sign-out; also attempts
// a start now in case a session was already restored from disk.
function init() {
  const c = client();
  if (!c) return; // unconfigured — social features stay inert, launcher runs offline
  try {
    c.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") { stop(); return; }
      if (session && (event === "SIGNED_IN" || event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED")) {
        start().catch(() => {});
      }
    });
  } catch { /* no realtime — reads/writes still work on demand */ }
  start().catch(() => {});
}

async function start() {
  const c = client();
  if (!c) return;
  const uid = await myId();
  if (!uid) return;
  if (started && me === uid) return; // idempotent
  if (started) stop();               // account changed under us
  me = uid;
  started = true;
  try { myProfile = await cloud.getProfile(); } catch { myProfile = null; }
  setupPresence();
  setupFriendsRealtime();
  startLastSeen();
}

function stop() {
  const c = client();
  try { if (presenceCh) { presenceCh.untrack().catch(() => {}); if (c) c.removeChannel(presenceCh); } } catch { /* best effort */ }
  try { if (friendsCh && c) c.removeChannel(friendsCh); } catch { /* best effort */ }
  if (lastSeenTimer) clearInterval(lastSeenTimer);
  presenceCh = null; friendsCh = null; lastSeenTimer = null;
  started = false; me = null; myProfile = null; currentActivity = DEFAULT_ACTIVITY;
}

// ---- Presence (ephemeral: Supabase Realtime Presence, keyed on the user id) --
function presencePayload() {
  return {
    user_id: me,
    status: "online",
    activity: currentActivity,
    username: (myProfile && myProfile.username) || null,
    display_name: (myProfile && myProfile.display_name) || null,
    minecraft_uuid: (myProfile && myProfile.minecraft_uuid) || null,
    minecraft_name: (myProfile && myProfile.minecraft_name) || null,
    online_at: new Date().toISOString(),
  };
}

function setupPresence() {
  const c = client();
  if (!c) return;
  presenceCh = c.channel(PRESENCE_CHANNEL, { config: { presence: { key: me } } });
  presenceCh
    .on("presence", { event: "sync" }, () => emitPresence())
    .on("presence", { event: "join" }, () => emitPresence())
    .on("presence", { event: "leave" }, () => emitPresence())
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        try { await presenceCh.track(presencePayload()); } catch { /* keep trying on next sync */ }
        emitPresence();
      }
    });
}

// Flatten the presence roster to { userId: { status, activity, ... } } and push
// it. The renderer intersects this with the friends list to light up dots.
function emitPresence() {
  if (!presenceCh) return;
  let state = {};
  try { state = presenceCh.presenceState() || {}; } catch { state = {}; }
  const online = {};
  for (const key of Object.keys(state)) {
    const metas = state[key];
    const meta = metas && metas.length ? metas[metas.length - 1] : null;
    if (!meta) continue;
    const uid = meta.user_id || key;
    online[uid] = {
      status: meta.status || "online",
      activity: meta.activity || DEFAULT_ACTIVITY,
      minecraft_name: meta.minecraft_name || null,
      online_at: meta.online_at || null,
    };
  }
  emit("cloud:presence", { online });
}

// Broadcast what I'm doing ("Playing <instance>" from the launch path, or the
// idle default). Fails soft when there's no live presence channel.
async function setActivity(text) {
  currentActivity = (text && String(text).trim()) || DEFAULT_ACTIVITY;
  if (presenceCh) { try { await presenceCh.track(presencePayload()); } catch { /* best effort */ } }
  return currentActivity;
}

async function touchLastSeen() {
  const c = client();
  if (!c || !me) return;
  try { await c.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", me); } catch { /* best effort */ }
}
function startLastSeen() {
  touchLastSeen();
  lastSeenTimer = setInterval(touchLastSeen, LAST_SEEN_MS);
  if (lastSeenTimer.unref) lastSeenTimer.unref(); // never keep the process alive just for this
}

// ---- Friendships realtime (requests/accepts appear live) --------------------
function setupFriendsRealtime() {
  const c = client();
  if (!c) return;
  friendsCh = c.channel("lodestone-friendships:" + me);
  const bump = () => { listFriends().then((d) => emit("cloud:friends", d)).catch(() => {}); };
  friendsCh
    // RLS already restricts these rows to ones I'm in; two filters cover both sides.
    .on("postgres_changes", { event: "*", schema: "public", table: "friendships", filter: `requester=eq.${me}` }, bump)
    .on("postgres_changes", { event: "*", schema: "public", table: "friendships", filter: `addressee=eq.${me}` }, bump)
    .subscribe();
}

// ---- Friends queries + mutations --------------------------------------------
async function myFriendships(uid) {
  const c = client();
  if (!c) return [];
  const { data, error } = await c.from("friendships")
    .select("*")
    .or(`requester.eq.${uid},addressee.eq.${uid}`);
  if (error) throw new Error(error.message);
  return data || [];
}

// People search — reuses the one authenticated query path in cloud.js, then
// annotates each hit with my existing relationship so the UI can show the right
// action (Add / Requested / Respond / Friends / Blocked).
async function searchPeople(query) {
  const c = client();
  if (!c) return [];
  const uid = await myId();
  if (!uid) return [];
  let hits = [];
  try { hits = await cloud.searchProfiles(query); } catch { return []; }
  if (!hits.length) return hits;
  let rels = [];
  try { rels = await myFriendships(uid); } catch { rels = []; }
  const byOther = {};
  for (const f of rels) {
    const other = f.requester === uid ? f.addressee : f.requester;
    byOther[other] = {
      id: f.id,
      status: f.status,
      incoming: f.addressee === uid && f.status === "pending",
      outgoing: f.requester === uid && f.status === "pending",
    };
  }
  return hits.map((h) => ({ ...h, relation: byOther[h.id] || null }));
}

// Accepted friends + pending requests (incoming and outgoing) + people I block,
// each hydrated with the other party's profile for names and skins.
async function listFriends() {
  const c = client();
  if (!c) return emptyFriends();
  const uid = await myId();
  if (!uid) return emptyFriends();
  let rows = [];
  try { rows = await myFriendships(uid); } catch { return emptyFriends(); }

  const otherIds = [...new Set(rows.map((f) => (f.requester === uid ? f.addressee : f.requester)))];
  const profiles = {};
  if (otherIds.length) {
    const { data } = await c.from("profiles").select(PROFILE_FIELDS).in("id", otherIds);
    for (const p of (data || [])) profiles[p.id] = p;
  }

  const out = emptyFriends();
  for (const f of rows) {
    const otherId = f.requester === uid ? f.addressee : f.requester;
    const entry = {
      id: f.id,
      status: f.status,
      user: profiles[otherId] || { id: otherId },
      created_at: f.created_at,
      updated_at: f.updated_at,
    };
    if (f.status === "accepted") out.friends.push(entry);
    else if (f.status === "pending" && f.addressee === uid) out.incoming.push(entry);
    else if (f.status === "pending" && f.requester === uid) out.outgoing.push(entry);
    else if (f.status === "blocked" && f.requester === uid) out.blocked.push(entry);
    // status 'blocked' where I'm the addressee = someone blocked me; hidden from my view.
  }
  out.friends.sort((a, b) => nameOf(a.user).localeCompare(nameOf(b.user)));
  return out;
}

async function sendRequest({ userId } = {}) {
  const c = requireClient();
  const uid = await requireUser();
  if (!userId) throw new Error("Pick someone to add.");
  if (userId === uid) throw new Error("You can't add yourself.");
  // Reuse an existing row (either direction) rather than creating a duplicate.
  const rows = await myFriendships(uid);
  const existing = rows.find((f) =>
    (f.requester === uid && f.addressee === userId) ||
    (f.requester === userId && f.addressee === uid));
  if (existing) {
    if (existing.status === "accepted") throw new Error("You're already friends.");
    if (existing.status === "blocked") throw new Error("This person is blocked. Unblock them first.");
    if (existing.status === "pending" && existing.addressee === uid) {
      // They already asked you — accept theirs instead of sending a mirror request.
      return respond({ id: existing.id, accept: true });
    }
    throw new Error("Friend request already sent.");
  }
  const { data, error } = await c.from("friendships")
    .insert({ requester: uid, addressee: userId, status: "pending" })
    .select("*").single();
  if (error) throw new Error(error.message);
  return data;
}

// Accept turns the pending row to 'accepted'; decline deletes it.
async function respond({ id, accept } = {}) {
  const c = requireClient();
  await requireUser();
  if (!id) throw new Error("Missing request.");
  if (accept) {
    const { data, error } = await c.from("friendships")
      .update({ status: "accepted" }).eq("id", id).select("*").single();
    if (error) throw new Error(error.message);
    return data;
  }
  const { error } = await c.from("friendships").delete().eq("id", id);
  if (error) throw new Error(error.message);
  return { id, removed: true };
}

async function remove({ id } = {}) {
  const c = requireClient();
  await requireUser();
  if (!id) throw new Error("Missing friend.");
  const { error } = await c.from("friendships").delete().eq("id", id);
  if (error) throw new Error(error.message);
  return { id, removed: true };
}

// A block is a friendship row with status 'blocked'. Reuse any existing row
// between us (in either direction); otherwise create one.
async function block({ userId } = {}) {
  const c = requireClient();
  const uid = await requireUser();
  if (!userId) throw new Error("Pick someone to block.");
  if (userId === uid) throw new Error("You can't block yourself.");
  const rows = await myFriendships(uid);
  const existing = rows.find((f) =>
    (f.requester === uid && f.addressee === userId) ||
    (f.requester === userId && f.addressee === uid));
  if (existing) {
    const { data, error } = await c.from("friendships")
      .update({ status: "blocked" }).eq("id", existing.id).select("*").single();
    if (error) throw new Error(error.message);
    return data;
  }
  const { data, error } = await c.from("friendships")
    .insert({ requester: uid, addressee: userId, status: "blocked" })
    .select("*").single();
  if (error) throw new Error(error.message);
  return data;
}

module.exports = {
  init, setEmitter, start, stop,
  searchPeople, listFriends, sendRequest, respond, remove, block,
  setActivity,
};
