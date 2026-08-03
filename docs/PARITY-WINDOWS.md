# Windows parity tracker

Every one of the Mac app's **89** feature views, listed individually. An
earlier version of this file grouped several views per row, which made it look
shorter than the real surface and let a few views go unnamed entirely — this
one is generated from the Mac source so it cannot drift.

**done** = present and matching · **partial** = exists but thinner than Mac ·
**missing** = not built · **n/a** = Mac-only by design.

| status | count |
|---|---|
| done | 79 |
| partial | 0 |
| missing | 10 |
| n/a | 1 |

| Mac view | Status | Notes |
|---|---|---|
| AIPackBuilderSheet | missing | needs an AI backend |
| AchievementsSheet | done | Play history screen |
| AddWorldSheet | done | folder or .zip import |
| AppSettingsView | done | preferences |
| BackupSettingsSheet | done | interval + keep count, skips running instances, prunes old copies |
| BrowseView | done | categories, sort, project pages |
| ClipRecorder | missing | needs screen capture |
| CloudHostingSheet | missing | needs a hosting provider |
| CommandPalette | done | Ctrl/Cmd-K |
| ConfigManagerSheet | done | every editable config |
| CrashDoctorSheet | done | crash scan + wired fixes |
| CulpritFinderSheet | done | bisect with library pinning + control round |
| CurseForgeBrowser | done | project pages, same shape as Modrinth |
| CurseForgeCleanup | done | unresolvable records + untracked jars, nothing auto-deleted |
| CurseForgeSearchView | done | search + project pages |
| CurseForgeSheets | done | detail + install |
| DatapacksSheet | done | packs vertical |
| DeleteForeverWorldSheet | missing | Forever Worlds not built |
| DropSupport | done | drag a pack onto the window |
| EditInstanceSheet | done | name/version/RAM/Java/icon/group/notes |
| FileBrowserTab | done | breadcrumb browser + editor |
| HealthView | done | real checks drive the screen and the chip |
| HeroHomeView | done | hero + rail |
| HomeCards | done | instance cards |
| Hubs | done | notes + links per instance |
| InstanceArtwork | done | recessed art well + drop target |
| InstanceHistorySheet | done | per-instance sessions |
| InstanceIconMaker | done | initials + palette |
| InstanceKeybindsTab | done | this instance's own binds |
| InstanceScreenshotsTab | done | grid, enlarge, copy, save, reveal, trash |
| InstancesView | done | groups, multi-select, reorder |
| KeybindSheets | done | capture + preset dialogs |
| KeybindsView | done | global library with discovery |
| LANWorldsSheet | done | real multicast listener |
| LaunchOverlay | done | launch progress |
| LaunchStatusBar | done | launch state |
| LinkTabView | done | per-instance links |
| LiveStatsOverlay | missing | needs an in-game overlay |
| LogConsole | done | tail, level filter, find, copy |
| MixinConflictsSheet | done | static scanner |
| ModpackEditor | done | pick what leaves the machine, export .mrpack |
| ModpacksView | done | curate contents and export, exclusions restored after |
| NewForeverWorldSheet | missing | Forever Worlds not built |
| NewWorldSheet | done | both save formats |
| NoteTabView | done | per-instance notes |
| OnboardingSheet | done | first run only |
| PackArtPicker | done | click or drop art |
| PerfInsightsBanner | done | memory + pack-size warnings |
| PlayView | done | Play screen |
| PlaytimeHeatmapView | done | year heatmap |
| PluginWebView | missing | needs a plugin runtime |
| PluginsView | missing | needs a plugin runtime |
| PregenSheet | missing | needs headless server + Chunky |
| ProfileSheet | done | account + profile |
| PublishSheet | missing | needs a publish target |
| RepairSheet | done | offered against the finding |
| ResourcePackManagerSheet | done | packs vertical |
| RootView | done | shell + sidebar |
| ScreenshotShare | done | copy image + save as |
| ScreenshotViewer | done | enlarge + actions |
| SeedFinderSheet | done | native cubiomes search |
| SeedInfoSheet | done | seed facts on world detail |
| SeedMapView | done | predicted biome map |
| ServerAccessSheet | done | whitelist/ops/bans |
| ServerConsoleSheet | done | live console |
| ServerDashboard | done | status, players, TPS, uptime |
| ServerHealthCard | done | same telemetry |
| ServerPluginsView | done | list + toggle |
| ServerSettingsSheet | done | server.properties |
| ServersView | done | list + empty state |
| SettingsView | done | behaviour + sources |
| SharePackToFriendSheet | done | permanent codes |
| ShareSheets | done | share + export |
| SidebarNotifications | done | bell + badge |
| SignInSheet | done | Microsoft device code |
| SkinsView | done | upload, reset, library |
| SlottedSlider | done | square-thumb slider |
| SocialView | done | friends + presence |
| SquadManagerSheet | done | list, invite codes, leave |
| StorageView | done | breakdown + reclaim |
| SyncedModpacksSheet | done | list, pull to rebuild locally, remove from cloud |
| ThemeBrowserSheet | n/a | Mac deliberately ships one theme |
| UpdatesSheet | done | version, updater state, release notes from the feed |
| VersionPickerSheet | done | version list per project |
| WorldDetailView | done | facts from level.dat |
| WorldManagerSheet | done | list/backup/restore/rename/delete |
| WorldMapView | done | explored map from region files |
| WorldStatisticsView | done | biomes, structures, player |
| WrappedSheet | done | year summary |

## What the missing ones need

None of the remaining gaps are UI work alone. They each need something that
does not exist on the Windows side yet: an AI backend, a screen-capture
pipeline, a hosting provider, a publish target, a plugin runtime, or a headless
server for pregeneration. Those are product decisions, not screens.
