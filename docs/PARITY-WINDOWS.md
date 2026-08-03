# Windows parity tracker

The Mac app is 89 feature views and ~65,000 lines of Swift. The Windows app is
~25 screens and ~14,000 lines. This file is the checklist that closes that gap.

It exists because the first attempt at parity was reactive — fixing whatever
turned up in the latest screenshot — which never converges. Every Mac view is
listed below with an honest status, so what is left is visible instead of being
rediscovered one complaint at a time.

Status: **done** = present and matching · **partial** = exists but thinner than
Mac · **missing** = not built · **n/a** = Mac-only for platform reasons.

## Shell & navigation
| Mac view | Status | Notes |
|---|---|---|
| RootView | done | sidebar, Play/Instances/Servers/Friends, PINNED, SETUP |
| HeroHomeView / HomeCards / PlayView | done | hero, chips, Play, Jump back in, Servers |
| InstancesView | done | groups, multi-select, bulk actions, drag-to-reorder; drive sections n/a |
| CommandPalette | done | Ctrl/Cmd-K |
| SidebarNotifications | done | bell + badge in the account foot, engine-written feed |
| OnboardingSheet | done | shown once, only when nothing is set up yet |
| Hubs / LinkTabView / NoteTabView | done | notes + links per instance, http(s) only |

## Instance detail
| Mac view | Status | Notes |
|---|---|---|
| Tab bar (All/Worlds/Screenshots/Keybinds/Logs/Tools) | done | fixed set |
| Mod list + toggles + update | done | icons, filter, state, sort |
| InstanceScreenshotsTab / ScreenshotViewer | done | grid, enlarge, copy, save-as, reveal, trash |
| LogConsole | done | tail, level filter with counts, find, copy |
| InstanceKeybindsTab | done | this instance's own options.txt binds, with clash marking |
| EditInstanceSheet | partial | name/version/RAM/Java; **no icon maker, no group, no notes** |
| HealthView / PerfInsightsBanner | done | real checks drive both the screen and the hero chip |
| InstanceHistorySheet | done | per-instance sessions from the instance menu |
| InstanceIconMaker | missing | generate an icon |
| FileBrowserTab | done | breadcrumb browser + text editor, path-escape guarded |
| ConfigManagerSheet | done | every editable config, grouped by folder |
| RepairSheet | done | offered inline against the finding that needs it |

## Worlds
| Mac view | Status | Notes |
|---|---|---|
| NewWorldSheet / AddWorldSheet | done | both save formats, seed parsing |
| WorldManagerSheet | partial | list/backup/restore/rename/delete |
| WorldDetailView | done | facts from level.dat (both save formats) + actions |
| WorldMapView | done | .mca reader + canvas biome map of generated chunks |
| WorldStatisticsView | done | biomes, structures, player position/health/XP and inventory |
| SeedMapView / SeedInfoSheet | done | predicted biome map from the seed, beside the explored map |
| SeedFinderSheet | done | native cubiomes helper |
| PregenSheet | missing | chunk pregeneration via Chunky |
| NewForeverWorldSheet / DeleteForeverWorldSheet | missing | Forever Worlds |
| PlaytimeHeatmapView / WrappedSheet / AchievementsSheet | done | one Play history screen off a real session log |

## Servers
| Mac view | Status | Notes |
|---|---|---|
| ServersView | done | list, empty state, LAN/where-to-host |
| ServerConsoleSheet / ServerSettingsSheet | done | console + server.properties |
| ServerDashboard / ServerHealthCard | done | live status, players, TPS, uptime, memory |
| ServerAccessSheet | done | whitelist/ops/bans, console when live, files when stopped |
| ServerPluginsView | done | list + enable/disable for Paper servers |
| CloudHostingSheet | missing | hosted-server flow |
| LANWorldsSheet | done | real multicast listener on 224.0.2.60:4445 |

## Content & sharing
| Mac view | Status | Notes |
|---|---|---|
| BrowseView | done | categories, sort, project page with gallery, versions and changelogs |
| CurseForge* (4 views) | partial | search + install only |
| ModpacksView / ModpackEditor | missing | pack authoring |
| ResourcePackManagerSheet / DatapacksSheet | done | via packs vertical |
| ShareSheets / SharePackToFriendSheet | done | permanent codes |
| SyncedModpacksSheet | partial | list only |
| PublishSheet / ScreenshotShare | missing | publishing |
| AIPackBuilderSheet | missing | AI pack builder |
| StorageView | done | breakdown by bucket + biggest instances; only caches clearable |

## Social & account
| Mac view | Status | Notes |
|---|---|---|
| SocialView / SignInSheet / ProfileSheet | done | friends, presence, auth |
| SquadManagerSheet | partial | squads exist; no manager |
| SkinsView | done | upload/reset, body render, and a local library you can re-wear from |
| SettingsView / AppSettingsView | partial | core prefs only |
| UpdatesSheet | partial | banner only |
| PluginsView / PluginWebView | missing | launcher plugins |
| ThemeBrowserSheet | n/a | Mac deliberately ships one theme |

## Not applicable
External-drive instance storage (Mac `libraryRoot`) has no Windows equivalent
in the engine, so drive sections in InstancesView are n/a until that ships.
