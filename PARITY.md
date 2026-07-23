# Windows parity roadmap

Goal: bring the full macOS (SwiftUI) Lodestone feature set to this Windows/Electron
build. The two share no code, so each feature is re-implemented in the JS engine
(`electron/engine/`) + web UI (`web/`). This file tracks what's done and what's next.

Legend: [x] done · [~] partial · [ ] not started

## Core loop
- [x] Instances: create / delete / list
- [x] Microsoft sign-in (device code)
- [x] Launch Vanilla
- [x] Launch Fabric + Quilt (loader install + overlay)
- [x] Launch NeoForge / Forge (runs the official installer once, overlays the profile)
- [x] Browse Modrinth (search)
- [x] **Mod install + management** — add mods/resource packs/shaders from Discover into an
      instance (with automatic required-dependency resolution), instance detail page, remove
- [~] Instance editing: rename / RAM / Java args / MC version (done); icon (todo)
- [x] World manager: backup / restore / rename / delete
- [~] `.mrpack` import (done); CurseForge / `.lodepack` import (todo)

## Power tools
- [x] Settings screen (default RAM, Java path override, data folder, update check, about)
- [x] CurseForge browse + install + `.zip` import (needs a user CurseForge API key)
- [x] **Resource pack / shader / datapack managers** (`packs.js` + instance-detail
      sections): resource packs with pack.mcmeta metadata + enable/disable/reorder
      via options.txt, shaders with Iris/Oculus activation (list-only fallback),
      per-world datapacks; .zip import, delete, open folder for all three
- [x] **Keybinds manager** (`keybinds.js`): options.txt `key_*` lines grouped by
      category with human key names, click-to-rebind (keyboard + mouse capture),
      conflict highlighting, reset-one / reset-all (byte-preserving line edits)
- [x] Repair (clear cached game files, re-download on next launch)
- [x] Update all mods (re-resolve installed Modrinth content to newest)
- [x] Command palette (Ctrl/Cmd-K)
- [ ] Crash doctor

## Servers & multiplayer
- [x] Servers tab + console (create vanilla/Paper/Fabric, start/stop, console, server.properties editor)
- [~] Hosting: LAN + Tailscale join addresses done; playit / exaroton / UPnP todo
- [ ] LAN worlds
- [~] Share a pack (share code + .mrpack) + one-click Sync now done; live cross-machine auto-sync needs accounts
- [ ] Squads

## Accounts & backend (Supabase)
- [x] **Accounts foundation** — Supabase project (Postgres + Auth + Realtime + RLS),
      full schema migration (`supabase/migrations`), a main-process client
      (`electron/engine/cloud.js`) with disk-persisted sessions + realtime shim,
      `cloud:*` IPC, and an **Account** tab (sign up / in / out, profile edit,
      link Minecraft). Runs fully offline until a project is connected (`SETUP.md`).
- [x] **Cloud Sync** (vertical A — `sync.js`): push an instance's manifest to
      `synced_instances`, pull + reconcile on another machine via share.js, live over Realtime.
- [ ] Connect a live project (2-min manual step — see `SETUP.md`) + smoke test end to end
      **← the only thing between "built" and "shippable"; blocks the v0.3.0 release**

## Social & extras
- [x] **Friends + Presence** (vertical B — `social.js`): search / request / accept /
      remove / block over `friendships`; live online status via Realtime Presence;
      launcher broadcasts "Playing <instance>".
- [x] **Chat + Squads** (vertical C — `chat.js`): squad channels + DMs over `messages`,
      create / join-by-code / leave squads, live delivery; join uses a SECURITY DEFINER
      RPC (`0002_squad_join_by_code.sql`) so RLS stays tight.
- [ ] Plugins (JS sandbox)
- [ ] Skins
- [ ] Themes
- [ ] Achievements / playtime heatmap / wrapped recap
- [ ] Onboarding
- [ ] Plugins (JS sandbox)
- [ ] Skins
- [ ] Themes
- [ ] Achievements / playtime heatmap / wrapped recap
- [ ] Onboarding

## Platform
- [x] Auto-update (electron-updater + GitHub Releases + CI)
- [ ] Code signing (removes the SmartScreen warning)

---
Order of attack: core loop → power tools → servers → social. Ship a release per
meaningful chunk so the installed build (and friends) stay current.
