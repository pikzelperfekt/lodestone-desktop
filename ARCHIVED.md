# Archived — 2026-08-03

**Parked, not abandoned.** Nothing here is deleted and nothing is half-finished.
The port reached full parity with the Mac app and shipped; work simply stops
here for a while.

## State at archival

| | |
|---|---|
| Last release | **v0.31.0** — published, installer + auto-update feed live |
| Working tree | clean |
| Unpushed commits | none |
| Tags | all pushed (`v0.9.0` → `v0.31.0`, 23 releases) |
| Parity | **88 of 89 views done, 0 partial, 0 missing, 1 n/a** |

Parity detail lives in `docs/PARITY-WINDOWS.md`, one row per Mac view. Its
summary counts recompute from its own rows — do not hand-edit those totals, they
drifted out of sync once already.

The single `n/a` is `AIPackBuilderSheet`, which is **dead code on the Mac too**
(unreferenced; its AI entry points were pulled). Building it here would make the
two apps *less* alike, not more.

## Picking it back up

```bash
cd "Documents/Claude Projects/lodestone-desktop"
npm install          # node_modules is ~549MB of the folder and is regenerable
npm start            # runs the app locally
```

To cut a release: bump `version` in `package.json`, commit, `git tag vX.Y.Z`,
push the tag. GitHub Actions builds the NSIS installer on a Windows runner and
publishes it plus `latest.yml`, so installed copies auto-update. The installer
asset name is stable, so the permanent download is:

```
https://github.com/pikzelperfekt/lodestone-desktop/releases/latest/download/Lodestone-Setup.exe
```

## Open threads, honestly listed

1. **`supabase/migrations/0004_presence_privacy.sql` is written but NOT applied.**
   Presence currently rides one shared Realtime channel, which has no RLS — every
   signed-in user receives every other online user's activity, username, and
   linked Minecraft name/UUID. The renderer only *filters* it for display. The
   migration turns presence into an RLS-backed table so the database enforces
   who may read a row. Applying it needs pasting into the Supabase SQL editor
   (the anon key cannot run DDL).

   **Applying it alone does not close the leak** — both clients still publish to
   the old global channel, so each needs a client-side switch too.

2. **Five sheets are unreachable on the *Mac*** (found while porting, not fixed
   here): in `PlayView.swift`'s `InstanceToolsTab`, `PublishSheet`,
   `SharePackToFriendSheet`, `SeedInfoSheet`, `ResourcePackManagerSheet` and that
   file's `showingPregen` are attached but their bindings are never set `true`.
   The features work; they just have no button. (Pregen *is* reachable, via
   `WorldDetailView`.) One line each, in the Mac repo.

3. **Unsigned build** — Windows SmartScreen warns on first run. Fixing that means
   buying a code-signing certificate.

## Things that will bite whoever returns

- **exaroton wraps failures in HTTP 200 `{success:false}`.** Unwrap the envelope;
  never trust the status code.
- **The plugin host's CSP needs `'unsafe-inline'` as well as `'unsafe-eval'`,**
  or its bootstrap script is refused and plugins silently never run.
- **Plugin code must be `postMessage`d from preload into the page context,**
  never evaluated in the preload — preload can reach `require("electron")`.
- **Verify the GIF encoder by decoding its output back to pixels,** not by
  checking the header. A wrong LZW still produces a valid-looking file.
- **`.inp` and friends:** `.inp { width:100% }` is declared after the component
  rules, so equal specificity plus source order lets it win. Out-specify it.
- **`[hidden]` loses to `display:flex`** — every flex element that can hide needs
  an explicit `[hidden] { display:none }`.
