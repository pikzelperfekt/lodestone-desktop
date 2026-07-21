# Backend contract (for the social/sync verticals)

The accounts **substrate** is in. Friends, chat/squads, and cross-machine sync
each build on it as an independent vertical. This is the frozen contract so the
three can be built in parallel without stepping on each other.

## The stack (how a feature flows end to end)

```
electron/engine/<vertical>.js   ← your logic; uses cloud.getClient()
  → electron/engine/index.js    ← aggregate: require + expose functions + export
  → electron/main.js            ← handle("cloud:<verb>", a => engine.<fn>(a))
  → electron/preload.js         ← window.lodestone.cloud.<x> + event allowlist
  → web/api.js                  ← API.cloud.<x> (with a browser-preview fallback)
  → web/app.js                  ← your render function + nav wiring
```

## The shared client — use it, don't make your own

```js
const cloud = require("./cloud");
const supa = cloud.getClient();          // authenticated Supabase client (throws if not configured / signed out)
const me   = await cloud.currentUser();  // { id, email, ... } or null
const prof = await cloud.getProfile();   // my profiles row
const hits = await cloud.searchProfiles("query");  // people search (username / display / mc name)
```

Realtime is ready: `supa.channel(...)` works (the `ws` shim is wired in `cloud.js`).
Push live updates to the renderer with the engine's `emit(channel, payload)` —
mirror how `server.js` streams `server:log`.

## Schema (already migrated — `supabase/migrations/0001_accounts_foundation.sql`)

All tables have RLS on; the anon key is public, so **the policies are the
security**. Do not loosen them.

- `profiles(id, username, display_name, minecraft_uuid, minecraft_name, avatar_url, bio, last_seen_at, ...)`
  — readable by any signed-in user; writable only by owner. Auto-created on signup.
- `friendships(id, requester, addressee, status['pending'|'accepted'|'blocked'], ...)`
  — visible to either party; insert as requester; either party updates/deletes.
- `squads(id, name, owner, invite_code)` + `squad_members(squad_id, user_id, role, joined_at)`
  — members read; owner manages; join inserts self. RLS recursion is handled by
  `is_squad_member()` / `is_squad_owner()` SECURITY DEFINER helpers.
- `messages(id, channel_type['dm'|'squad'], channel_id, sender, body, created_at)`
  — DM `channel_id` = sorted `"uuidA:uuidB"`; squad `channel_id` = squad id.
  Read/insert allowed only to channel participants.
- `synced_instances(id, owner, client_instance_id, name, mc_version, loader, manifest jsonb, device, updated_at)`
  — owner-only. `manifest` mirrors the share-code payload.

Realtime is enabled on `messages`, `friendships`, `synced_instances`, `profiles`.

## Vertical assignments (own your files; hub files merge additively)

Each vertical **owns** a new engine module + a new `web/app.js` render function +
its own `API.cloud.<ns>` block. You will also add a few lines to the shared hub
files (`index.js`, `main.js`, `preload.js`, `web/api.js`, nav in `index.html` +
`navigate()` router). Those few-line additions conflict trivially at merge and
get resolved by the integrator — keep them small and clearly grouped.

- **A — Cloud Sync** (`sync.js`): push each instance's manifest to
  `synced_instances`, pull others, reconcile via the existing `share.js`
  (`exportInstanceCode` / `syncInstanceFromCode`). UI: a "Cloud sync" control in
  the instance detail + a "Synced from your other devices" list. Live updates via
  `emit("cloud:sync", …)`.
- **B — Friends + Presence** (`social.js`): friend search/request/accept/remove
  over `friendships`; live online status via **Supabase Realtime Presence**
  (ephemeral channel, not a table) + `profiles.last_seen_at`. UI: a **Friends**
  nav section (`renderFriends`). Emits `cloud:friends`, `cloud:presence`.
- **C — Chat + Squads** (`chat.js`): DM + squad messages over `messages`, squad
  create/join/leave over `squads`/`squad_members`. UI: a **Squads** nav section +
  a chat panel. Emits `cloud:message`.

The renderer event channels `cloud:friends`, `cloud:presence`, `cloud:message`,
`cloud:sync` are already in the preload allowlist — just emit and subscribe.

## Conventions

- IPC: wrap in the existing `handle("cloud:<verb>", …)`; it already returns
  `{ok,data}` / `{ok,error}`.
- Never block the app when signed out or unconfigured — fail soft, like
  `cloud.status()` does.
- Match the design tokens (`web/design-tokens.css`) and the `.cloud-*` styles
  already in `web/styles.css`.
