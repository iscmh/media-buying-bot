-- Triggers and helpers.
-- Run AFTER drizzle has created the tables. Workflow:
--   1. pnpm --filter @mbb/db generate       (drizzle creates tables migration)
--   2. supabase db push                     (drizzle migration → DB)
--   3. supabase migration up                (applies these SQL files)

-- -------------------------------------------------------------------------
-- updated_at: bump on every UPDATE for tables that carry the column.
-- -------------------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  t record;
begin
  for t in
    select c.table_name
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.column_name  = 'updated_at'
  loop
    execute format(
      'drop trigger if exists set_updated_at on public.%I; '
      'create trigger set_updated_at before update on public.%I '
      'for each row execute function public.tg_set_updated_at();',
      t.table_name, t.table_name
    );
  end loop;
end $$;

-- -------------------------------------------------------------------------
-- auth.users → public.users sync.
--   * On INSERT into auth.users: create a public.users row with the same id.
--   * On DELETE from auth.users: cascade soft-delete (set deleted_at).
--   * Default role = 'user'. Admins promoted manually via SQL.
-- -------------------------------------------------------------------------
create or replace function public.tg_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, full_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name')
  )
  on conflict (id) do nothing;

  -- Seed default settings row so the safety layer always finds it.
  insert into public.user_settings (user_id) values (new.id) on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists handle_new_auth_user on auth.users;
create trigger handle_new_auth_user
after insert on auth.users
for each row execute function public.tg_handle_new_auth_user();

-- -------------------------------------------------------------------------
-- Global emergency stop: enforce single row (id = 1) and seed it.
-- -------------------------------------------------------------------------
alter table public.global_emergency_stop
  drop constraint if exists global_emergency_stop_singleton;
alter table public.global_emergency_stop
  add constraint global_emergency_stop_singleton check (id = 1);

insert into public.global_emergency_stop (id, is_active)
values (1, false)
on conflict (id) do nothing;

-- -------------------------------------------------------------------------
-- Feature flags: ensure global rows have null user_id; user rows non-null.
-- -------------------------------------------------------------------------
alter table public.feature_flags
  drop constraint if exists feature_flags_scope_userid_consistent;
alter table public.feature_flags
  add constraint feature_flags_scope_userid_consistent check (
    (scope = 'global' and user_id is null)
    or (scope = 'user' and user_id is not null)
  );
