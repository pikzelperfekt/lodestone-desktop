-- Lodestone accounts + social/sync foundation.
--
-- One migration establishes the whole backend contract every vertical builds
-- against: accounts (profiles), friends, presence's durable half (last_seen),
-- squads, chat history, and cross-machine instance sync. RLS is on for every
-- table; the anon key the app ships is public by design, so these policies are
-- the actual security boundary. Realtime is enabled where clients need live
-- pushes (chat, friend requests, sync).
--
-- Live status/presence itself (online, "playing X") rides Supabase Realtime
-- Presence (ephemeral, no table) — only last_seen_at is persisted here.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- Bump updated_at on every UPDATE. Attached per-table below.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Squad membership/ownership checks used inside RLS policies. SECURITY DEFINER
-- so they bypass RLS on squad_members/squads — this is what breaks the classic
-- "policy queries the same table it protects" recursion.
create or replace function public.is_squad_member(p_squad uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.squad_members
    where squad_id = p_squad and user_id = p_user
  );
$$;

create or replace function public.is_squad_owner(p_squad uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.squads
    where id = p_squad and owner = p_user
  );
$$;

-- ---------------------------------------------------------------------------
-- profiles — one row per auth user, auto-created on signup
-- ---------------------------------------------------------------------------
-- Publicly readable to any signed-in user (friend search + rendering names and
-- Minecraft skins needs it); writable only by the owner.
create table public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  username       text unique not null,
  display_name   text,
  minecraft_uuid text,
  minecraft_name text,
  avatar_url     text,
  bio            text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_seen_at   timestamptz
);
alter table public.profiles enable row level security;

create policy "profiles readable by signed-in users"
  on public.profiles for select to authenticated using (true);
create policy "insert own profile"
  on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy "update own profile"
  on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Auto-provision a profile whenever a new auth user signs up. Username defaults
-- to a collision-free slug off the user id; the client can rename it later.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'username', ''),
      'player_' || substr(replace(new.id::text, '-', ''), 1, 8)
    ),
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      nullif(new.raw_user_meta_data ->> 'username', '')
    )
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- friendships — request/accept/block between two profiles
-- ---------------------------------------------------------------------------
-- Directional row: requester -> addressee. "My friends" = accepted rows where
-- I'm on either side. A block is a friendship row with status 'blocked'.
create table public.friendships (
  id         uuid primary key default gen_random_uuid(),
  requester  uuid not null references public.profiles (id) on delete cascade,
  addressee  uuid not null references public.profiles (id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending', 'accepted', 'blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friendship_distinct check (requester <> addressee),
  constraint friendship_unique unique (requester, addressee)
);
alter table public.friendships enable row level security;

create policy "see friendships you're in"
  on public.friendships for select to authenticated
  using (auth.uid() = requester or auth.uid() = addressee);
create policy "request friendships as yourself"
  on public.friendships for insert to authenticated
  with check (auth.uid() = requester);
create policy "respond to friendships you're in"
  on public.friendships for update to authenticated
  using (auth.uid() = requester or auth.uid() = addressee)
  with check (auth.uid() = requester or auth.uid() = addressee);
create policy "remove friendships you're in"
  on public.friendships for delete to authenticated
  using (auth.uid() = requester or auth.uid() = addressee);

create trigger friendships_touch before update on public.friendships
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- squads — named groups with an invite code + a member roster
-- ---------------------------------------------------------------------------
create table public.squads (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 80),
  owner       uuid not null references public.profiles (id) on delete cascade,
  invite_code text unique not null default encode(extensions.gen_random_bytes(6), 'hex'),
  created_at  timestamptz not null default now()
);
alter table public.squads enable row level security;

create table public.squad_members (
  squad_id  uuid not null references public.squads (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  role      text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (squad_id, user_id)
);
alter table public.squad_members enable row level security;

create policy "members see their squads"
  on public.squads for select to authenticated
  using (public.is_squad_member(id, auth.uid()));
create policy "owner creates squads"
  on public.squads for insert to authenticated with check (auth.uid() = owner);
create policy "owner updates squads"
  on public.squads for update to authenticated
  using (auth.uid() = owner) with check (auth.uid() = owner);
create policy "owner deletes squads"
  on public.squads for delete to authenticated using (auth.uid() = owner);

create policy "members see the roster"
  on public.squad_members for select to authenticated
  using (public.is_squad_member(squad_id, auth.uid()));
create policy "join a squad as yourself"
  on public.squad_members for insert to authenticated
  with check (auth.uid() = user_id);
create policy "leave or be removed"
  on public.squad_members for delete to authenticated
  using (auth.uid() = user_id or public.is_squad_owner(squad_id, auth.uid()));

-- ---------------------------------------------------------------------------
-- messages — chat history for DMs and squads
-- ---------------------------------------------------------------------------
-- channel_type = 'dm'  -> channel_id is the sorted pair "uuidA:uuidB"
-- channel_type = 'squad' -> channel_id is the squad id.
-- CASE guards the squad-only uuid cast so a 'dm' channel_id never gets cast.
create table public.messages (
  id           bigint generated always as identity primary key,
  channel_type text not null check (channel_type in ('dm', 'squad')),
  channel_id   text not null,
  sender       uuid not null references public.profiles (id) on delete cascade,
  body         text not null check (char_length(body) between 1 and 4000),
  created_at   timestamptz not null default now()
);
alter table public.messages enable row level security;
create index messages_channel_idx on public.messages (channel_type, channel_id, created_at);

create policy "read messages in your channels"
  on public.messages for select to authenticated
  using (
    case channel_type
      when 'squad' then public.is_squad_member(channel_id::uuid, auth.uid())
      when 'dm' then auth.uid()::text in (split_part(channel_id, ':', 1), split_part(channel_id, ':', 2))
      else false
    end
  );
create policy "send messages to your channels"
  on public.messages for insert to authenticated
  with check (
    sender = auth.uid()
    and case channel_type
      when 'squad' then public.is_squad_member(channel_id::uuid, auth.uid())
      when 'dm' then auth.uid()::text in (split_part(channel_id, ':', 1), split_part(channel_id, ':', 2))
      else false
    end
  );

-- ---------------------------------------------------------------------------
-- synced_instances — cross-machine sync of an instance's manifest
-- ---------------------------------------------------------------------------
-- manifest mirrors the share-code payload (loader + mc version + mod list with
-- hashes/versions). Devices push their manifest and pull others' to reconcile;
-- the actual jars are re-fetched from Modrinth/CurseForge client-side, so this
-- stays small. Owner-only, full stop.
create table public.synced_instances (
  id                 uuid primary key default gen_random_uuid(),
  owner              uuid not null references public.profiles (id) on delete cascade,
  client_instance_id text not null,
  name               text not null,
  mc_version         text,
  loader             text,
  manifest           jsonb not null default '{}'::jsonb,
  device             text,
  updated_at         timestamptz not null default now(),
  constraint synced_owner_client_unique unique (owner, client_instance_id)
);
alter table public.synced_instances enable row level security;

create policy "read own synced instances"
  on public.synced_instances for select to authenticated using (auth.uid() = owner);
create policy "insert own synced instances"
  on public.synced_instances for insert to authenticated with check (auth.uid() = owner);
create policy "update own synced instances"
  on public.synced_instances for update to authenticated
  using (auth.uid() = owner) with check (auth.uid() = owner);
create policy "delete own synced instances"
  on public.synced_instances for delete to authenticated using (auth.uid() = owner);

create trigger synced_touch before update on public.synced_instances
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Realtime — tables clients subscribe to for live pushes
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.friendships;
alter publication supabase_realtime add table public.synced_instances;
alter publication supabase_realtime add table public.profiles;
