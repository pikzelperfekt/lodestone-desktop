# Lodestone (Windows)

> **Archived 2026-08-03 — parked, not abandoned.** Feature-complete against the
> Mac app (88/89 views) and shipped at **v0.31.0**; active development is paused.
> Nothing is deleted and the release/auto-update pipeline still works. See
> [ARCHIVED.md](ARCHIVED.md) for the exact state, how to resume, and the open threads.

A Mac-native Minecraft launcher, packaged for Windows via Electron. Built on the
Modrinth + Mojang APIs. Create instances, sign in with Microsoft, and launch Vanilla,
Fabric, or Quilt.

This repo is the **Windows distribution** of Lodestone. The macOS app is a separate
native Swift build.

## For players

Grab the latest **`Lodestone-Setup-x.y.z.exe`** from
[Releases](https://github.com/pikzelperfekt/lodestone-desktop/releases), run it, and
play. It installs per-user (no admin prompt) and **updates itself** — when a new version
ships, the app downloads it in the background and offers a "Restart" button.

> First launch shows a Windows SmartScreen notice because the app isn't code-signed yet.
> Click **More info → Run anyway**. (Auto-updates work regardless.)

## Develop

```bash
npm install
npm start        # run the app in dev
```

- `electron/` — main process + the Node "engine" (auth, install, launch, loaders).
- `web/` — the UI (renderer).

## Cut a release (→ everyone auto-updates)

1. Bump the version in `package.json` (e.g. `0.2.0` → `0.2.1`).
2. Commit, then tag and push:
   ```bash
   git commit -am "v0.2.1"
   git tag v0.2.1
   git push && git push --tags
   ```
3. The `release` GitHub Action builds the Windows installer on a Windows runner and
   publishes it (plus `latest.yml`) to Releases. Installed apps pick it up automatically.

The tag (`vX.Y.Z`) must match `package.json`'s version (`X.Y.Z`).
