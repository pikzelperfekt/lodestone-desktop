-- Presence, made private.
--
-- THE LEAK THIS CLOSES
-- Presence rode Supabase Realtime Presence on ONE shared channel. Realtime
-- Presence has no RLS: every signed-in user received every other online user's
-- payload — activity ("Playing <pack>"), username, display name, and their
-- linked Minecraft name and UUID. It only LOOKED private because the renderer
-- intersected the roster with your friends list before drawing it. Anyone
-- running a modified client, or just reading the websocket, saw everybody.
--
-- WHY NOT PER-FRIEND CHANNELS
-- A channel named presence:<a>:<b> sounds private but isn't: Realtime does not
-- restrict who may join a topic, and profile ids are discoverable through user
-- search. Anyone could derive the topic for two people and listen in. That is
-- obscurity, not access control.
--
-- WHAT THIS DOES INSTEAD
-- Presence becomes a TABLE with RLS, so the database decides who may read a
-- row. Realtime applies RLS to postgres_changes subscriptions, so a client is
-- only ever sent rows it is allowed to select. Clients heartbeat their own row
-- and are treated as offline once it goes stale, which is why ONLINE_WINDOW
-- exists below.
--
-- Trade-off, stated plainly: presence is no longer instant-offline on socket
-- drop; it expires after the staleness window instead. That is the price of
-- having the server enforce visibility, and it is worth paying.

-- ---------------------------------------------------------------- helper ----
-- Defined BEFORE the table it is used by is fine here because it only touches
-- friendships, which already exists. (The `language sql` bodies are validated
-- at CREATE time — see 0003 for the ordering trap this project already hit.)
create or replace function public.is_friend(a uuid, b uuid)
returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester = a and f.addressee = b)
        or (f.requester = b and f.addressee = a))
  );
$$;

-- ----------------------------------------------------------------- table ----
create table if not exists public.presence (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  status         text not null default 'online' check (status in ('online', 'away', 'offline')),
  activity       text,
  -- Denormalised so a friend can render your row without a second lookup, and
  -- so we never have to widen the profiles SELECT policy to make presence work.
  minecraft_name text,
  updated_at     timestamptz not null default now()
);

create index if not exists presence_updated_at_idx on public.presence (updated_at desc);

-- ------------------------------------------------------------------- RLS ----
alter table public.presence enable row level security;

-- The whole point: you can read your own row, and your accepted friends' rows.
-- Nobody else's. Realtime honours this for postgres_changes, so a non-friend is
-- not merely filtered in the UI — they are never sent the row at all.
drop policy if exists presence_select on public.presence;
create policy presence_select on public.presence
  for select to authenticated
  using (user_id = auth.uid() or public.is_friend(auth.uid(), user_id));

-- You may only ever write your own presence.
drop policy if exists presence_insert on public.presence;
create policy presence_insert on public.presence
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists presence_update on public.presence;
create policy presence_update on public.presence
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists presence_delete on public.presence;
create policy presence_delete on public.presence
  for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------- realtime --
-- Guarded: `alter publication ... add table` throws if the table is already a
-- member, which would make re-running this whole file fail on its last line.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'presence'
  ) then
    alter publication supabase_realtime add table public.presence;
  end if;
end
$$;
