# Cloud backend setup

Lodestone's account, friends, chat, squads and cross-machine sync run on a
Supabase project (Postgres + Auth + Realtime). **The launcher works 100% offline
without this** — until a project is connected, the Account tab shows a "not set
up" state and nothing else changes. This is the one manual, ~2-minute step.

## Recommended: a free cloud project (the real production backend)

1. Create a project at <https://supabase.com> (free tier is plenty). Pick a
   region close to you; save the database password.
2. In the dashboard, open **Project Settings → API** and copy:
   - **Project URL** (e.g. `https://abcd1234.supabase.co`)
   - **anon public** key (the long JWT). This key is *public by design* — the
     row-level security in `supabase/migrations` is the real security boundary,
     so it is safe to ship and commit.
3. Push the schema. With the [Supabase CLI](https://supabase.com/docs/guides/cli)
   installed:
   ```bash
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```
   No CLI? Open **SQL Editor** in the dashboard, paste the contents of
   `supabase/migrations/0001_accounts_foundation.sql`, and run it.
4. Tell the app about the project. Either:
   - Edit `electron/cloud.config.json` and fill in `url` + `anonKey` (this ships
     inside the installer, so every user connects to your backend), **or**
   - Drop a `cloud.config.json` with the same two fields into the app data dir
     (`%APPDATA%/Lodestone` on Windows) to override without rebuilding.
5. Restart Lodestone. The Account tab now offers sign up / sign in.

## Alternative: local Docker stack (dev only)

Needs Docker Desktop. `supabase start` boots the full stack locally; it prints a
local URL + anon key to paste into `cloud.config.json`. Good for development, but
friends on other machines can't reach `localhost` — you still want a cloud
project for real multiplayer social.

## Auth notes

- Email confirmations are **off** for launch (`supabase/config.toml`) so signup
  works instantly. The signup path already handles the confirmation-required
  case, so turning it on later needs no app change.

## Hardening (later, not blockers)

- **SMTP**: configure a real email sender in Supabase, then flip
  `enable_confirmations = true` for verified emails + password resets.
- **OAuth (Discord)**: `config.toml` already points `site_url` at the
  `lodestone://auth-callback` deep link for a future one-click Discord sign-in.
- **Rate limits / abuse**: Supabase's defaults are sane; revisit if it gets busy.
