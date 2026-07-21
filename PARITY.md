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
- [ ] Resource pack / shader / datapack managers (dedicated views)
- [ ] Keybinds manager
- [ ] Repair (clear cached game files)
- [ ] In-app "update all content"
- [ ] Command palette (⌘/Ctrl-K)
- [ ] Crash doctor

## Servers & multiplayer
- [x] Servers tab + console (create vanilla/Paper/Fabric, start/stop, console, server.properties editor)
- [ ] Hosting: LAN / Tailscale / playit / exaroton (make a server public)
- [ ] LAN worlds
- [ ] Share a pack to a friend + keep a shared pack in sync (instant sharing / auto-sync)
- [ ] Squads

## Social & extras
- [ ] Friends / presence / chat (needs the backend)
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
