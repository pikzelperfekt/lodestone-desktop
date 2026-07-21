// Cloud Sync (Vertical A) — mirror an instance's mod manifest to the cloud so the
// same pack can be rebuilt on another machine, and auto-reconcile when a device
// changes it. Builds on the accounts substrate (cloud.js) and reuses the offline
// reconcile engine (share.js): the manifest we store IS the share-code payload
// (share.packDef), and pulling replays it through the exact same install/update/
// remove path a pasted code would (share.syncInstance / share.createFromDef).
//
// Everything here fails soft: if the backend isn't configured or nobody's signed
// in, reads return empty and explicit actions throw one clean, friendly line —
// they never hang and never take the launcher down. The realtime channel is
// filtered to the signed-in owner (owner-only RLS on synced_instances) and pushes
// `cloud:sync` to the renderer so every open window/device updates live.
const os = require("os");
const cloud = require("./cloud");
const share = require("./share");

// Injected once by index.js so the instance store + reconcile path stay in one
// place (same DI pattern share.js uses). { getInstance, listInstances,
// syncFromCode, createFromCode }.
let store = null;
let emit = () => {};
let channel = null; // the live Realtime subscription (null when signed out / unconfigured)

function init(s) { store = s || null; }
function setEmitter(fn) { emit = fn || (() => {}); }

// A DB row (snake_case) → the friendly shape the renderer renders.
function mapRow(r) {
  if (!r) return null;
  const manifest = r.manifest && typeof r.manifest === "object" ? r.manifest : {};
  return {
    id: r.id,
    clientInstanceId: r.client_instance_id,
    name: r.name,
    mcVersion: r.mc_version,
    loader: r.loader,
    device: r.device,
    updatedAt: r.updated_at,
    modCount: Array.isArray(manifest.mods) ? manifest.mods.length : 0,
    manifest,
  };
}

// Resolve the authenticated client + current user, or null when unavailable.
// Never throws — callers that must be strict re-check `me` and throw their own line.
async function session() {
  let supa;
  try { supa = cloud.getClient(); } catch { return { supa: null, me: null }; }
  let me = null;
  try { me = await cloud.currentUser(); } catch { me = null; }
  return { supa, me };
}

// Normalize a stored manifest back into a share definition and re-encode it as a
// share code, so pull replays through the identical share.js reconcile path.
function codeFromRow(row) {
  const m = row.manifest && typeof row.manifest === "object" ? row.manifest : {};
  const def = {
    name: m.name || row.name || "Synced pack",
    loader: m.loader || row.loader || "vanilla",
    mcVersion: m.mcVersion || row.mc_version || "",
    mods: Array.isArray(m.mods) ? m.mods : [],
  };
  return share.encodeCode(def);
}

// ---- Push: upsert this instance's manifest under owner+client_instance_id ----
async function pushInstance(instanceId) {
  const { supa, me } = await session();
  if (!supa) throw new Error("Cloud isn't set up yet — see SETUP.md.");
  if (!me) throw new Error("Sign in to your Lodestone account to sync instances.");
  const inst = store && store.getInstance(instanceId);
  if (!inst) throw new Error("Instance not found.");

  const def = share.packDef(inst); // == the share-code payload; manifest mirrors it
  const row = {
    owner: me.id,
    client_instance_id: inst.id,
    name: def.name,
    mc_version: def.mcVersion,
    loader: def.loader,
    manifest: def,
    device: os.hostname(),
    updated_at: new Date().toISOString(), // stamp the push time even when nothing changed
  };
  const { data, error } = await supa
    .from("synced_instances")
    .upsert(row, { onConflict: "owner,client_instance_id" })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  const mapped = mapRow(data);
  emit("cloud:sync", { type: "push", row: mapped }); // snappy local echo; realtime confirms cross-device
  return mapped;
}

// ---- List: the signed-in user's synced instances, newest first (fail soft) ----
async function listCloud() {
  const { supa, me } = await session();
  if (!supa || !me) return [];
  const { data, error } = await supa
    .from("synced_instances")
    .select("*")
    .eq("owner", me.id)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(mapRow);
}

// ---- Status for one instance: drives the instance-detail "Cloud sync" control ----
// { configured, signedIn, row|null } — mirrors cloud.status()'s fail-soft contract.
async function syncStatus(instanceId) {
  const st = await cloud.status();
  if (!st.configured || !st.signedIn) return { configured: st.configured, signedIn: st.signedIn, row: null };
  const { supa, me } = await session();
  if (!supa || !me) return { configured: st.configured, signedIn: st.signedIn, row: null };
  const { data, error } = await supa
    .from("synced_instances")
    .select("*")
    .eq("owner", me.id)
    .eq("client_instance_id", instanceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return { configured: true, signedIn: true, row: data ? mapRow(data) : null };
}

// ---- Pull: reconcile the matching local instance, or add it as a new one ----
// Matches by client_instance_id. Found → replay through share's syncFromCode
// (install missing / update changed / remove extras). Not found → createFromCode.
async function pullInstance({ id } = {}) {
  if (!id) throw new Error("No synced instance to pull.");
  const { supa, me } = await session();
  if (!supa) throw new Error("Cloud isn't set up yet — see SETUP.md.");
  if (!me) throw new Error("Sign in to your Lodestone account to sync instances.");

  const { data: row, error } = await supa.from("synced_instances").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error("That synced instance isn't available anymore.");

  const code = codeFromRow(row);
  const local = store && store.listInstances().find((i) => i.id === row.client_instance_id);

  if (local) {
    const r = await store.syncFromCode({ id: local.id, code });
    return { mode: "synced", instanceName: r.instance ? r.instance.name : row.name,
      added: r.added, removed: r.removed, unchanged: r.unchanged };
  }
  const r = await store.createFromCode(code);
  return { mode: "created", instanceName: r.instance ? r.instance.name : row.name,
    added: r.added, removed: r.removed, unchanged: r.unchanged };
}

// ---- Remove: delete a cloud row (owner-only via RLS) ----
async function removeCloud({ id } = {}) {
  if (!id) throw new Error("No synced instance to remove.");
  const { supa, me } = await session();
  if (!supa) throw new Error("Cloud isn't set up yet — see SETUP.md.");
  if (!me) throw new Error("Sign in to your Lodestone account to sync instances.");
  const { error } = await supa.from("synced_instances").delete().eq("id", id);
  if (error) throw new Error(error.message);
  emit("cloud:sync", { type: "remove", row: { id } });
  return { removed: true };
}

// ---- Realtime: live-reconcile pushes across a user's windows/devices ----
// Idempotent: tears down any prior channel and, when signed in, opens a fresh one
// scoped to this owner. Called on init (persisted session) + after sign-in; a
// no-op when unconfigured/signed out. Never throws (a missing ws shim just means
// no live updates — pushes/pulls still work).
async function start() {
  stop();
  try {
    const { supa, me } = await session();
    if (!supa || !me) return;
    channel = supa
      .channel("synced_instances:" + me.id)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "synced_instances", filter: `owner=eq.${me.id}` },
        (payload) => {
          const rec = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
          emit("cloud:sync", { type: (payload.eventType || "change").toLowerCase(), row: mapRow(rec) });
        }
      )
      .subscribe();
  } catch { channel = null; }
}

function stop() {
  if (channel) { try { channel.unsubscribe(); } catch { /* best effort */ } channel = null; }
}

module.exports = {
  init, setEmitter, start, stop,
  pushInstance, listCloud, pullInstance, removeCloud, syncStatus,
};
