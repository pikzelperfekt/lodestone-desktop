# Lodestone Feature-Parity Audit — macOS (reference) vs Windows/Electron (port target)

Audited 2026-07-23 against Mac @ `feat/external-storage` (`b1a568a`, post "July feature wave")
and Windows @ `feat/accounts`. Every status judged from the Windows code, not PARITY.md claims.
Score: ~24 SAME · ~17 PARTIAL · ~40 MISSING. This file is the transfer roadmap; PARITY.md tracks
the ship-state checkboxes.

Legend: **SAME** (equivalent) · **PARTIAL** (exists but weaker) · **MISSING**.

## 1. Mac features → Windows status

### A. Core loop — instances, launch, editing
1. **Instances view (groups, pinning, sort modes, manual drag order, multi-select bulk ops)** — Mac `Features/InstancesView.swift` (1,222 ln) + `App/InstanceGroupStore.swift`. Win `web/app.js renderInstances` = flat last-played list. **PARTIAL**
2. **Snapshots & historical Alpha/Beta versions** (+ Rosetta Java 8 on Mac) — Win `listVersions` filters `type==="release"` only. **MISSING**. Windows port is *simpler*: stop filtering + install `jre-legacy` (no Rosetta needed on x64).
3. **Edit instance** — Win has name/RAM/javaArgs/mcVersion; no accent color, no dev-mod sources. **PARTIAL**
4. **Instance icons/artwork** — Win has picked image + generated tile; no 2×2 mod-icon composite, no remote-pack-icon fetch. **PARTIAL**
5. **Launch pipeline (5 loaders, exact Mojang JRE, log streaming)** — **SAME**
6. **JVM auto-tune (Aikar) + perf insights + GC-log analysis** — Mac `JVMTuner.swift`/`PerformanceTuner.swift`. **MISSING** (pure, portable)
7. **Battery-aware launch** — **MISSING**; port battery half only (thermal = not-portable)
8. **Live stats overlay (FPS sparkline + RAM HUD)** — parser is pure. **MISSING**
9. **GIF clip recorder** — CGWindowList. **MISSING — Mac-bound**; Windows path = Electron `desktopCapturer`
10. **Launch overlay over the game window** — Win has in-launcher overlay only. **PARTIAL** (acceptable equivalent)
11. **Pre-launch health check (HealthChecker incl. dup-jar)** — **MISSING** as a pre-flight surface
12. **Preflight disk guard** — **MISSING**, trivially portable
13. **Repair instance** — **SAME**
14. **Storage manager (cache inspection/pruning per category)** — **MISSING**
15. **External-drive instance storage + drive bulk ops** (`libraryRoot`) — Win fixed userData dir. **MISSING**
16. **Dock quick-launch** — Mac-bound; Windows equivalent = jump list (`app.setUserTasks`). **MISSING**
17. **Command palette** — **SAME** (minus plugin commands)
18. **Customizable Home dashboard (7 widget types)** — Win static hero (greeting hardcoded "KingEstel"). **PARTIAL**
19. **Customizable sidebar + note/link tabs + notifications bell** — **MISSING**
20. **Onboarding wizard** — **MISSING**
21. **Multi-account switcher** — Win single account.json AND never uses refresh token (see §3.3 — bug). **MISSING**
22. **Auto-update** — **SAME** (Sparkle ≙ electron-updater)

### B. Content
23. **Unified Discover (Modrinth + CurseForge)** — **SAME**
24. **NL mod search "Ask" mode** — **MISSING**
25. **Keyless CurseForge webview capture browser + de-clutter** — **MISSING** (Electron webview + will-download)
26. **Content install w/ dependency resolution** — **SAME**
27. **Version picker (install/pin specific build)** — **MISSING**
28. **Enable/disable mods w/ dependency cascade; remove w/ config cleanup** — Win remove only. **PARTIAL**
29. **Informed & reversible "Update all" (changelogs, breaking flags, snapshot, rollback)** — Win blind bump. **PARTIAL**
30. **Instance History (snapshots capture/restore)** — **MISSING**
31. **Drag-drop content install per instance (.jar/.zip classification)** — Win pack-files only. **PARTIAL**
32. **Pack import (.mrpack/CF zip/.lodepack v1+v2, unified router)** — **SAME**
33. **Pack export (.mrpack/.lodepack v2/share code)** — **SAME**
34. **AI Pack Builder** — **MISSING**
35. **Modpacks page (curated + local authored + editor)** — **MISSING**
36. **Publish pack/profile to public pages** — **MISSING** (worker-backed; backend decision needed)
37. **Config manager (structured TOML/properties/JSON editor)** — **MISSING**
38. **Resource pack manager** — **SAME**
39. **Shader management (Iris/Oculus)** — **SAME**
40. **Datapack manager** — **SAME** in function (delete tier differs, §3.1)
41. **Keybinds system (global+per-instance presets, library, two-way sync, applied at launch)** — Win per-instance editor only. **PARTIAL**
42. **Global game-settings profile (Game hub)** — Win "Game" tab is a placeholder stub. **MISSING**
43. **Skins manager** — **MISSING**
44. **Sinytra Connector & VulkanMod add-ons** — **MISSING** (Sinytra portable; VulkanMod moot on Windows)
45. **Content-addressed mod dedup (SHA-1 + hardlinks)** — **MISSING** (NTFS hardlinks fine)
46. **Developer mode DevModSync** — **MISSING**

### C. Worlds
47. **World manager (duplicate, screenshots gallery+share, Trash-tier delete, NBT rename)** — Win list/backup/restore/folder-rename/permanent-delete. **PARTIAL**
48. **Achievements viewer** — **MISSING**
49. **Seed info + slime-chunk map (pure math + NBT)** — **MISSING**, very portable
50. **Per-launch + scheduled world backups w/ retention** — Win manual only. **MISSING**
51. **LAN worlds (multicast discover + quick-play join)** — **MISSING** (Node dgram portable)

### D. Diagnostics
52. **Crash Doctor** — **SAME** (genuinely at parity)
53. **AI crash explainer** — **MISSING**
54. **Culprit Finder (automated parallel ddmin bisect)** — Win manual bisect. **PARTIAL**
55. **Compatibility Lab (learning conflict ledger)** — **MISSING**

### E. Servers & multiplayer
56. **Servers from-instance / import-modpack + always-on supervisor** — Win fresh standalone only. **PARTIAL**
57. **Platforms: + NeoForge/Forge/Quilt servers, Paper/Purpur/Sponge** — Win vanilla/Paper/Fabric. **PARTIAL**
58. **Server dashboard (Console/Health/Plugins/Settings tabs)** — Win console+properties+hosting. **PARTIAL**
59. **server.properties editor** — **SAME**
60. **Server world backup/restore/reset** — **MISSING**
61. **Server mods tab w/ client/server tagging** — **MISSING**
62. **Server file browser + inline editor** — **MISSING**
63. **TPS monitor + health card + scheduled restarts** — **MISSING**
64. **Server plugin manager** — **MISSING**
65. **Server access control (whitelist/ops/bans/ban-ips + UUID resolve)** — **MISSING**
66. **Hosting: UPnP, playit.gg, cloudflared, exaroton, Oracle guide** — Win LAN+Tailscale only. **PARTIAL** (playit/cloudflared ship Windows binaries — easier than Mac)
67. **Companion phone/web console** — **MISSING** (LocalRelayServer → Node http/ws = home turf)
68. **Forever Worlds (locked survival worlds, auto-follow releases, high-friction delete)** — **MISSING**

### F. Social
69. **Friends/presence/requests/chat** — both exist on DIFFERENT backends (Mac=Worker/MC-UUID, Win=Supabase). **PARTIAL/architectural fork** — friends on the two apps cannot see each other today; unification via Supabase in progress (Mac feat/accounts).
70. **Send pack straight to a friend (relay + accept/install)** — **MISSING** on Win
71. **Per-friend synced-pack links (scoped, pausable)** — Win has own-instance cloud sync instead. **PARTIAL**
72. **Squad manager (group + shared server + member sync + invites)** — Win "squads" = chat channels (different feature). **MISSING**
73. **Play-together provisioning (ProfileProvisioner, pure logic)** — **MISSING**
74. **Discord Rich Presence** — **MISSING** (named pipe on Windows, same JSON framing)
75. **Cloud backup of instance list** — **SAME capability, different backend**

### G. Platform & chrome
76. **Themes (palettes + JSON disk themes + gallery)** — **MISSING** (design-tokens.css already variable-based)
77. **Plugins (sandboxed JS, permissioned bridge, registry)** — **MISSING** (needs real sandbox — NOT Node `vm`)
78. **Playtime heatmap** — **MISSING**
79. **Wrapped recap** — **MISSING**
80. **Global log console** — **PARTIAL**
81. **File association / `lodestone:` URL open** — **PARTIAL** (no open-file/second-instance handling)

## 2. Windows-only features (Mac lacks)
1. **Supabase accounts vertical** (email auth, profiles, link-Minecraft, RLS schema) — Mac port IN PROGRESS on its feat/accounts
2. **Squad chat channels + DMs w/ history + join-by-code RPC** — Mac has 1:1 relay chat only
3. **Per-instance cloud sync records w/ live reconcile** — Mac's is a whole-list blob
4. **Offline-session launch fallback** — Mac hard-requires an account
5. **Manual persistent bisect UX** — worth keeping alongside a ported CulpritFinder

## 3. Behavior mismatches
1. **Delete tiers**: Mac = instances permanent (deliberate), worlds/screenshots/datapacks → macOS Trash, Forever Worlds gated. Win = everything permanent. Fix: `shell.trashItem` for the world/pack tier.
2. **World rename**: Mac rewrites NBT `LevelName`; Win renames folder only (in-game name stays stale).
3. **Auth freshness (BUG)**: Mac mints fresh session from refresh token at launch; Win saves refreshToken but never uses it → online play silently degrades ~24h after sign-in.
4. **Update-all**: Mac reviewed+snapshot+rollback; Win blind bump.
5. **Import formats**: at parity (only gap: no per-instance jar/zip drops on Win).
6. **External drives**: Mac library-aware; Win single fixed dir.
7. **Server creation**: Mac from-instance/import + 8 platforms + supervisor; Win fresh standalone 3 platforms.
8. **Keybinds model**: Mac global preset applied at every launch + two-way sync; Win one-file editor.
9. **CurseForge**: Win key-mandatory; Mac keyless webview capture covers browse/install.
10. **Presence**: two incompatible backends today; Supabase unification is the fix (in progress).

## 4. Transfer-wave plan

**Wave 0 — correctness (tiny, first):** MSA token refresh at launch; trash-tier deletes; world-rename NBT rewrite; snapshot/historical versions (unfilter + jre-legacy).

**Wave 1 — daily-driver value:**
- 1A "Safety net & updates": SnapshotManager + Instance History + informed Updates sheet + scheduled/per-launch world backups + PreflightGuard + dup-jar pre-launch check
- 1B "Content depth": Game-settings profile (fills the Game stub) + keybind presets/global profile + config manager + version picker + enable/disable w/ cascade + per-instance drag-drop classifier
- 1C "Organization & performance": instance groups/pins/sort/bulk ops + JVM auto-tune + perf insights + live stats (parser) + playtime heatmap + Wrapped + multi-account switcher + battery half

**Wave 2 — multiplayer & server ops:**
- 2A "Server dashboard depth": TPS/health/restarts + server world backup + access control + plugin manager + file browser + server mods tab + Purpur/Sponge + instance-backed servers + supervisor
- 2B "Reach & hosting": playit.gg + cloudflared + UPnP + exaroton + LAN worlds + companion web console
- 2C "Social depth" (⚠ after backend unification): send-pack-to-friend + notifications + friend-scoped sync links + squad manager + play-together provisioning + Discord RPC

**Wave 3 — long tail:**
- 3A "AI suite": Ask search, AI Pack Builder + validator, AI crash explainer, automated Culprit Finder, CompatLab
- 3B "Worlds & identity": achievements, seed/slime map, screenshots gallery, world duplicate, skins, Forever Worlds
- 3C "Chrome & platform": themes, home widgets + custom sidebar/tabs, onboarding, storage manager + external-drive libraries, CF webview capture, mod dedup, jump list, file associations, plugins LAST (sandbox lift)

**Not-portable / Windows-native replacements:** ClipRecorder & over-game overlay & stats window-targeting (→ desktopCapturer / in-app HUD first), Rosetta (unneeded), thermal half of battery-aware, macOS Trash (→ shell.trashItem), Dock menu (→ jump list), VulkanMod framing (moot), Sparkle (→ electron-updater, done).
