// Vertical B — Friends + Presence.
//
// Builds on the accounts substrate in cloud.js. Two halves:
//   1. Friends: request / accept / remove / block over the `friendships` table
//      (a directional requester -> addressee row; "my friends" = accepted rows
//      I'm on either side of). People search reuses cloud.searchProfiles.
//   2. Presence: who's online and what they're doing. This is a TABLE with RLS
//      (`presence`), NOT Realtime Presence on a shared channel. It used to be
//      the latter, and that leaked: Realtime Presence has no RLS, so every
//      signed-in user received everyone's activity and linked Minecraft
//      identity — it only looked private because the renderer filtered the
//      roster against your friends list before drawing it. Now the database
//      decides who may read a row and Realtime honours that for
//      postgres_changes, so a non-friend is never sent the row at all.
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
const DEFAULT_ACTIVITY = "In launcher";
const LAST_SEEN_MS = 60 * 1000;
// Presence is a heartbeat now rather than a socket the server watches, so
// "online" means "wrote a row recently". The beat has to be comfortably
// shorter than the window or a friend flickers offline between writes.
const PRESENCE_BEAT_MS = 25 * 1000;
const ONLINE_WINDOW_MS = 75 * 1000;

let emit = () => {};
let started = false;
let me = null;               // my user id while a presence session is live
let myProfile = null;        // cached profile for the presence payload
let presenceCh = null;       // Realtime postgres_changes on `presence` (RLS-filtered)
let presenceTimer = null;    // heartbeat writing my own presence row
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
  startPresenceBeat();
}

function stop() {
  const c = client();
  // Mark myself offline on the way out so friends don't wait for the window.
  goOffline();
  try { if (presenceCh && c) c.removeChannel(presenceCh); } catch { /* best effort */ }
  try { if (friendsCh && c) c.removeChannel(friendsCh); } catch { /* best effort */ }
  if (lastSeenTimer) clearInterval(lastSeenTimer);
  if (presenceTimer) clearInterval(presenceTimer);
  presenceCh = null; friendsCh = null; lastSeenTimer = null; presenceTimer = null;
  started = false; me = null; myProfile = null; currentActivity = DEFAULT_ACTIVITY;
}

// ---- Presence (a table with RLS — see 0004_presence_privacy.sql) -----------
// My own row. Deliberately carries only what a friend needs to render the row:
// status, activity and the Minecraft name. The uuid is NOT published here — it
// was part of the old broadcast payload and nothing in the UI needs it.
function presenceRow() {
  return {
    user_id: me,
    status: "online",
    activity: currentActivity,
    minecraft_name: (myProfile && myProfile.minecraft_name) || null,
    updated_at: new Date().toISOString(),
  };
}

async function writePresence(row) {
  const c = client();
  if (!c || !me) return;
  try { await c.from("presence").upsert(row, { onConflict: "user_id" }); }
  catch { /* presence is best-effort; never surface it */ }
}

// Heartbeat. "Online" is "wrote recently", so this has to keep beating while
// the launcher is open.
function startPresenceBeat() {
  writePresence(presenceRow());
  presenceTimer = setInterval(() => writePresence(presenceRow()), PRESENCE_BEAT_MS);
  if (presenceTimer.unref) presenceTimer.unref(); // never hold the process open
}

function goOffline() {
  if (!me) return;
  const c = client();
  if (!c) return;
  // Fire-and-forget: sign-out shouldn't wait on the network.
  try {
    c.from("presence")
      .update({ status: "offline", updated_at: new Date().toISOString() })
      .eq("user_id", me)
      .then(() => {}, () => {});
  } catch { /* best effort */ }
}

// Subscribe to the presence table. RLS means Realtime only ever delivers rows
// for me and my accepted friends, so there is nothing to filter client-side.
function setupPresence() {
  const c = client();
  if (!c) return;
  presenceCh = c.channel("lodestone-presence-rows:" + me)
    .on("postgres_changes", { event: "*", schema: "public", table: "presence" }, () => refreshPresence())
    .subscribe((status) => { if (status === "SUBSCRIBED") refreshPresence(); });
}

// Read the rows I'm allowed to see and push the roster. Rows older than the
// window count as offline — a client that quit without marking itself offline
// (crash, killed process, lost network) would otherwise look online forever.
async function refreshPresence() {
  const c = client();
  if (!c || !me) return;
  let rows = [];
  try {
    const { data, error } = await c.from("presence").select("*");
    if (error) return;
    rows = data || [];
  } catch { return; }

  const cutoff = Date.now() - ONLINE_WINDOW_MS;
  const online = {};
  for (const r of rows) {
    if (r.status === "offline") continue;
    const seen = Date.parse(r.updated_at || "") || 0;
    if (seen < cutoff) continue;
    online[r.user_id] = {
      status: r.status || "online",
      activity: r.activity || DEFAULT_ACTIVITY,
      minecraft_name: r.minecraft_name || null,
      online_at: r.updated_at || null,
    };
  }
  emit("cloud:presence", { online });
}

// Broadcast what I'm doing ("Playing <instance>" from the launch path, or the
// idle default). Fails soft when signed out or unconfigured.
async function setActivity(text) {
  currentActivity = (text && String(text).trim()) || DEFAULT_ACTIVITY;
  if (me) await writePresence(presenceRow());
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
  const bump = () => {
    listFriends().then((d) => emit("cloud:friends", d)).catch(() => {});
    // Also re-read presence: accepting a friend makes their EXISTING row
    // readable to me, and no INSERT/UPDATE fires on it to wake the
    // subscription. Without this a new friend shows offline until they move.
    refreshPresence();
  };
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
