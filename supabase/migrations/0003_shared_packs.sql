-- Shared packs: one permanent code, live two-way propagation.
--
-- WHY THIS EXISTS
-- The original "share code" was base64(pack manifest) — the code WAS the
-- payload. So every mod change produced a brand new code, and a friend who
-- pasted the old one held a dead snapshot with no link back to the owner.
-- There was no channel for an update to ever arrive.
--
-- This replaces that with a stable POINTER. A shared pack is a row; its code
-- never changes. Members mirror it into their own local instance, so nobody
-- is reading anyone else's instance — the editor publishes a new manifest and
-- every member's client applies it. Separate installs that stay identical.
--
-- MODE decides who may publish:
--   'owner'    — only the owner's edits propagate (default; a hosted modpack)
--   'everyone' — any member may publish (a group pack everyone maintains)
-- Enforced in RLS, not just in the UI, because the anon key is public.
--
-- ADDITIVE to 0001/0002: touches no existing table or policy.

-- ---------------------------------------------------------------- tables ----
create table if not exists public.shared_packs (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null references auth.users (id) on delete cascade,
  -- The permanent share code. Stable for the life of the pack: changing mods
  -- must never change this, which was the entire bug.
  code         text not null unique,
  name         text not null,
  mc_version   text not null default '',
  loader       text not null default 'vanilla',
  manifest     jsonb not null default '{}'::jsonb,
  mode         text not null default 'owner' check (mode in ('owner', 'everyone')),
  -- Bumped on every publish so clients can ignore echoes of their own write.
  revision     bigint not null default 1,
  updated_by   uuid references auth.users (id) on delete set null,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists shared_packs_owner_idx on public.shared_packs (owner);

create table if not exists public.shared_pack_members (
  pack_id            uuid not null references public.shared_packs (id) on delete cascade,
  member             uuid not null references auth.users (id) on delete cascade,
  -- Which local instance on THAT member's machine mirrors this pack. Lets a
  -- client route an incoming update to the right folder without guessing.
  client_instance_id text,
  joined_at          timestamptz not null default now(),
  primary key (pack_id, member)
);

create index if not exists shared_pack_members_member_idx on public.shared_pack_members (member);

-- --------------------------------------------------------------- helpers ----
-- DEFINED AFTER THE TABLES ON PURPOSE. These are `language sql`, and Postgres
-- validates a sql function's body at CREATE time (unlike plpgsql, which defers
-- to first call). Declaring them above shared_pack_members aborts the whole
-- migration with 42P01 — exactly how the first live run of 0001 failed.
create or replace function public.is_pack_member(p_pack uuid)
returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.shared_pack_members m
    where m.pack_id = p_pack and m.member = auth.uid()
  );
$$;

create or replace function public.can_publish_pack(p_pack uuid)
returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.shared_packs p
    where p.id = p_pack
      and (
        p.owner = auth.uid()
        or (p.mode = 'everyone' and public.is_pack_member(p.id))
      )
  );
$$;

-- ------------------------------------------------------------------- RLS ----
alter table public.shared_packs        enable row level security;
alter table public.shared_pack_members enable row level security;

-- Read: the owner, and anyone who has joined.
drop policy if exists shared_packs_select on public.shared_packs;
create policy shared_packs_select on public.shared_packs
  for select using (owner = auth.uid() or public.is_pack_member(id));

drop policy if exists shared_packs_insert on public.shared_packs;
create policy shared_packs_insert on public.shared_packs
  for insert with check (owner = auth.uid());

-- Publish: owner always; members only when the pack is in 'everyone' mode.
-- The USING and WITH CHECK halves both apply, so a member cannot flip a pack
-- to 'everyone' and then edit it: reassigning owner/mode is owner-only.
drop policy if exists shared_packs_update on public.shared_packs;
create policy shared_packs_update on public.shared_packs
  for update
  using (public.can_publish_pack(id))
  with check (
    public.can_publish_pack(id)
    and owner = (select p.owner from public.shared_packs p where p.id = shared_packs.id)
    and (
      mode = (select p.mode from public.shared_packs p where p.id = shared_packs.id)
      or owner = auth.uid()
    )
  );

drop policy if exists shared_packs_delete on public.shared_packs;
create policy shared_packs_delete on public.shared_packs
  for delete using (owner = auth.uid());

-- Membership is visible to everyone in the pack, so the UI can list members.
drop policy if exists shared_pack_members_select on public.shared_pack_members;
create policy shared_pack_members_select on public.shared_pack_members
  for select using (member = auth.uid() or public.is_pack_member(pack_id));

-- You may only ever add/remove YOURSELF (joining happens via the RPC below).
drop policy if exists shared_pack_members_insert on public.shared_pack_members;
create policy shared_pack_members_insert on public.shared_pack_members
  for insert with check (member = auth.uid());

drop policy if exists shared_pack_members_update on public.shared_pack_members;
create policy shared_pack_members_update on public.shared_pack_members
  for update using (member = auth.uid()) with check (member = auth.uid());

-- Leave yourself, or be removed by the pack owner.
drop policy if exists shared_pack_members_delete on public.shared_pack_members;
create policy shared_pack_members_delete on public.shared_pack_members
  for delete using (
    member = auth.uid()
    or exists (select 1 from public.shared_packs p where p.id = pack_id and p.owner = auth.uid())
  );

-- ------------------------------------------------------------------- RPC ----
-- Join by code. Same shape as join_squad_by_code: the SELECT policy is
-- member-only, so a prospective member cannot resolve the code to an id on
-- their own. SECURITY DEFINER enrols the CALLING user and nobody else.
create or replace function public.join_pack_by_code(p_code text, p_client_instance_id text default null)
returns public.shared_packs
language plpgsql security definer set search_path = public as $$
declare
  v_pack public.shared_packs;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;

  select * into v_pack
  from public.shared_packs
  where code = upper(trim(p_code));

  if v_pack.id is null then
    raise exception 'No shared pack found for that code.';
  end if;

  insert into public.shared_pack_members (pack_id, member, client_instance_id)
  values (v_pack.id, auth.uid(), p_client_instance_id)
  on conflict (pack_id, member)
    do update set client_instance_id = coalesce(excluded.client_instance_id,
                                                shared_pack_members.client_instance_id);

  return v_pack;
end;
$$;

grant execute on function public.join_pack_by_code(text, text) to authenticated;

-- Invite a friend directly by account, with no code changing hands. Owner-only.
create or replace function public.invite_to_pack(p_pack uuid, p_member uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  if not exists (select 1 from public.shared_packs p where p.id = p_pack and p.owner = auth.uid()) then
    raise exception 'Only the pack owner can invite.';
  end if;

  insert into public.shared_pack_members (pack_id, member)
  values (p_pack, p_member)
  on conflict (pack_id, member) do nothing;
end;
$$;

grant execute on function public.invite_to_pack(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- realtime --
-- The live channel that makes "they add a mod, it appears for me" work.
alter publication supabase_realtime add table public.shared_packs;
alter publication supabase_realtime add table public.shared_pack_members;
