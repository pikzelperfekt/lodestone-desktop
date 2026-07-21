-- Chat + Squads (Vertical C): join a squad by its invite code.
--
-- ADDITIVE to 0001. It changes no existing table or policy — it only adds one
-- SECURITY DEFINER function, the same recursion-/visibility-breaking pattern the
-- foundation already uses for is_squad_member() / is_squad_owner().
--
-- Why it's needed: the squads SELECT policy is member-only, so a prospective
-- member cannot look a squad up by its invite code to discover the id they'd need
-- to insert into squad_members. This function resolves the code and enrolls the
-- *calling* user as a plain member. It does NOT loosen the policies: it never
-- exposes squads the caller isn't joining, only ever inserts auth.uid() itself,
-- and is safe to call twice (on-conflict no-op).

create or replace function public.join_squad_by_code(p_code text)
returns public.squads
language plpgsql security definer set search_path = public as $$
declare
  v_squad public.squads;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;

  select * into v_squad
  from public.squads
  where invite_code = lower(trim(p_code));

  if v_squad.id is null then
    raise exception 'No squad found for that invite code.';
  end if;

  insert into public.squad_members (squad_id, user_id, role)
  values (v_squad.id, auth.uid(), 'member')
  on conflict (squad_id, user_id) do nothing;

  return v_squad;
end;
$$;

grant execute on function public.join_squad_by_code(text) to authenticated;
