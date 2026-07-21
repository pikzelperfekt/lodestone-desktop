// The Lodestone cloud account client — the shared substrate every social/sync
// feature builds on. Wraps a single Supabase client (auth + Postgres + Realtime)
// living in the main process, and exposes a small JSON surface over IPC (the
// `cloud:*` channels). This is a SEPARATE identity from the Minecraft account in
// auth.js: that one launches the game, this one is who you are to friends.
//
// Design notes that matter to the vertical modules (sync/social/chat):
//   - getClient() returns the authenticated singleton; call it, don't new your own.
//   - The session is persisted to disk via a file-backed storage adapter, because
//     Node has no localStorage. Sessions survive restarts and auto-refresh.
//   - Realtime needs a WebSocket; Electron's Node (20) has no global one, so we
//     shim `ws` before creating the client. Subscriptions Just Work after that.
//   - If no project is configured yet, status().configured === false and every
//     call fails soft — the launcher still runs 100% offline.
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// Realtime transport shim: Electron main (Node 20) lacks a global WebSocket.
if (typeof globalThis.WebSocket === "undefined") {
  try { globalThis.WebSocket = require("ws"); } catch { /* realtime will be inert */ }
}

let DATA_DIR = null;
let client = null;         // the Supabase client singleton (null until configured)
let config = null;         // { url, anonKey }
let cachedProfile = null;  // last-known profile row for the signed-in user
let emit = () => {};        // pushes cloud:* events to the renderer

function setEmitter(fn) { emit = fn || (() => {}); }

// ---- Config resolution: data-dir override → bundled → env ------------------
function resolveConfig() {
  const candidates = [];
  if (DATA_DIR) candidates.push(path.join(DATA_DIR, "cloud.config.json"));
  candidates.push(path.join(__dirname, "..", "cloud.config.json"));
  for (const file of candidates) {
    try {
      const c = JSON.parse(fs.readFileSync(file, "utf8"));
      if (c && c.url && c.anonKey) return { url: String(c.url).trim(), anonKey: String(c.anonKey).trim() };
    } catch { /* try next */ }
  }
  const envUrl = process.env.SUPABASE_URL || process.env.LODESTONE_SUPABASE_URL;
  const envKey = process.env.SUPABASE_ANON_KEY || process.env.LODESTONE_SUPABASE_ANON_KEY;
  if (envUrl && envKey) return { url: envUrl.trim(), anonKey: envKey.trim() };
  return null;
}

function isConfigured(c) {
  return !!(c && /^https?:\/\//.test(c.url) && c.anonKey && c.anonKey.length > 20);
}

// ---- File-backed auth storage (stands in for localStorage in Node) ---------
function makeFileStorage(file) {
  let mem = {};
  try { mem = JSON.parse(fs.readFileSync(file, "utf8")); } catch { mem = {}; }
  const flush = () => { try { fs.writeFileSync(file, JSON.stringify(mem)); } catch { /* best effort */ } };
  return {
    getItem: (key) => (key in mem ? mem[key] : null),
    setItem: (key, value) => { mem[key] = value; flush(); },
    removeItem: (key) => { delete mem[key]; flush(); },
  };
}

// ---- Lifecycle -------------------------------------------------------------
function init(dataDir) {
  DATA_DIR = dataDir;
  config = resolveConfig();
  if (!isConfigured(config)) { client = null; return; }

  const storage = makeFileStorage(path.join(DATA_DIR, "cloud.session.json"));
  client = createClient(config.url, config.anonKey, {
    auth: {
      storage,
      storageKey: "lodestone-auth",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });

  // Keep the renderer's account widget honest as tokens refresh / sessions end.
  client.auth.onAuthStateChange(async (event) => {
    if (event === "SIGNED_OUT") { cachedProfile = null; emit("cloud:auth", { signedIn: false, profile: null }); return; }
    if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
      try { cachedProfile = await loadProfile(); } catch { /* keep last */ }
      emit("cloud:auth", { signedIn: true, profile: cachedProfile });
    }
  });
}

function getClient() {
  if (!client) throw new Error("Cloud isn't configured yet. Add your Supabase project in SETUP.md.");
  return client;
}

// ---- Auth ------------------------------------------------------------------
async function currentUser() {
  if (!client) return null;
  const { data } = await client.auth.getUser();
  return data && data.user ? data.user : null;
}

async function loadProfile() {
  const user = await currentUser();
  if (!user) return null;
  const { data, error } = await client.from("profiles").select("*").eq("id", user.id).single();
  if (error) throw new Error(error.message);
  cachedProfile = data;
  return data;
}

async function status() {
  if (!isConfigured(config)) return { configured: false, signedIn: false, profile: null };
  const user = await currentUser();
  if (!user) return { configured: true, signedIn: false, profile: null };
  let profile = cachedProfile;
  if (!profile) { try { profile = await loadProfile(); } catch { profile = null; } }
  return { configured: true, signedIn: true, profile, email: user.email };
}

async function signUp({ email, password, username }) {
  const c = getClient();
  if (!email || !password) throw new Error("Email and password are required.");
  if (password.length < 8) throw new Error("Use a password of at least 8 characters.");
  const meta = {};
  if (username && username.trim()) meta.username = username.trim();
  const { data, error } = await c.auth.signUp({ email: email.trim(), password, options: { data: meta } });
  if (error) throw new Error(error.message);
  // With email confirmations off a session is returned immediately.
  if (data.session) { cachedProfile = await loadProfile().catch(() => null); }
  return { signedIn: !!data.session, needsConfirmation: !data.session, profile: cachedProfile };
}

async function signIn({ email, password }) {
  const c = getClient();
  const { data, error } = await c.auth.signInWithPassword({ email: (email || "").trim(), password });
  if (error) throw new Error(error.message);
  cachedProfile = await loadProfile().catch(() => null);
  return { signedIn: !!data.session, profile: cachedProfile };
}

async function signOut() {
  if (!client) return true;
  await client.auth.signOut();
  cachedProfile = null;
  return true;
}

// ---- Profile ---------------------------------------------------------------
async function getProfile() {
  return cachedProfile || (await loadProfile());
}

async function updateProfile(patch) {
  const c = getClient();
  const user = await currentUser();
  if (!user) throw new Error("Not signed in.");
  const allowed = {};
  for (const k of ["username", "display_name", "bio", "avatar_url"]) {
    if (patch && patch[k] !== undefined) allowed[k] = patch[k];
  }
  const { data, error } = await c.from("profiles").update(allowed).eq("id", user.id).select("*").single();
  if (error) throw new Error(error.message);
  cachedProfile = data;
  emit("cloud:auth", { signedIn: true, profile: data });
  return data;
}

// Attach the launcher's Minecraft identity to the cloud profile (name + skin
// source for the social layer). `mc` = { name, uuid } from the Minecraft auth.
async function linkMinecraft(mc) {
  const c = getClient();
  const user = await currentUser();
  if (!user) throw new Error("Not signed in.");
  if (!mc || !mc.uuid) throw new Error("Sign in to Minecraft first, then link it.");
  const { data, error } = await c.from("profiles")
    .update({ minecraft_uuid: mc.uuid, minecraft_name: mc.name })
    .eq("id", user.id).select("*").single();
  if (error) throw new Error(error.message);
  cachedProfile = data;
  emit("cloud:auth", { signedIn: true, profile: data });
  return data;
}

// Find people by username / display name / Minecraft name (friend search). Used
// by the social vertical; lives here so there's one authenticated query path.
async function searchProfiles(query) {
  const c = getClient();
  const q = (query || "").trim();
  if (q.length < 2) return [];
  const like = `%${q}%`;
  const { data, error } = await c.from("profiles")
    .select("id, username, display_name, minecraft_name, minecraft_uuid, avatar_url")
    .or(`username.ilike.${like},display_name.ilike.${like},minecraft_name.ilike.${like}`)
    .limit(25);
  if (error) throw new Error(error.message);
  const me = (await currentUser())?.id;
  return (data || []).filter((p) => p.id !== me);
}

module.exports = {
  init, setEmitter, getClient, status,
  signUp, signIn, signOut,
  getProfile, updateProfile, linkMinecraft, searchProfiles,
  currentUser, loadProfile,
};
