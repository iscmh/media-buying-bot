-- =========================================================================
-- Row-Level Security: every user-scoped table enforces ownership.
-- =========================================================================
-- Non-negotiable. Tested in packages/db/tests/multi-tenant-isolation.test.ts.
--
-- Pattern:
--   * Enable RLS on table.
--   * `select_own`, `insert_own`, `update_own`, `delete_own` policies that
--     check user_id = auth.uid().
--   * `admin_all` policy giving role='admin' users full access.
--   * service_role (used by server-side jobs) bypasses RLS by default.
--
-- Logs / append-only tables: SELECT scoped to owner + admin; no INSERT
-- policy for clients (writes only via service_role from jobs).
-- =========================================================================

-- Helper: is the current JWT for an admin?
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.role = 'admin' and u.deleted_at is null
  );
$$;

-- -------------------------------------------------------------------------
-- users
-- -------------------------------------------------------------------------
alter table public.users enable row level security;

drop policy if exists users_select_own on public.users;
create policy users_select_own on public.users
  for select using (id = auth.uid() or public.is_admin());

drop policy if exists users_update_own on public.users;
create policy users_update_own on public.users
  for update using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- INSERT/DELETE happens via the auth.users trigger only.

-- -------------------------------------------------------------------------
-- Generic per-user-owned tables.
-- -------------------------------------------------------------------------
do $$
declare
  t text;
  user_owned text[] := array[
    'meta_connections',
    'telegram_connections',
    'ai_provider_connections',
    'user_settings',
    'concepts',
    'generation_jobs',
    'generated_creatives',
    'campaigns',
    'ad_sets',
    'ads',
    'daily_summaries',
    'partner_referrals'
  ];
begin
  foreach t in array user_owned loop
    execute format('alter table public.%I enable row level security;', t);

    execute format('drop policy if exists %I_select_own on public.%I;',  t, t);
    execute format(
      'create policy %I_select_own on public.%I for select using (user_id = auth.uid() or public.is_admin());',
      t, t
    );

    execute format('drop policy if exists %I_insert_own on public.%I;',  t, t);
    execute format(
      'create policy %I_insert_own on public.%I for insert with check (user_id = auth.uid() or public.is_admin());',
      t, t
    );

    execute format('drop policy if exists %I_update_own on public.%I;',  t, t);
    execute format(
      'create policy %I_update_own on public.%I for update using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());',
      t, t
    );

    execute format('drop policy if exists %I_delete_own on public.%I;',  t, t);
    execute format(
      'create policy %I_delete_own on public.%I for delete using (user_id = auth.uid() or public.is_admin());',
      t, t
    );
  end loop;
end $$;

-- -------------------------------------------------------------------------
-- Logs / append-only: SELECT scoped, no client INSERT.
-- -------------------------------------------------------------------------
do $$
declare
  t text;
  log_tables text[] := array[
    'audit_logs',
    'meta_api_call_logs',
    'performance_logs',
    'user_pause_log',
    'rate_limit_events'
  ];
begin
  foreach t in array log_tables loop
    execute format('alter table public.%I enable row level security;', t);

    execute format('drop policy if exists %I_select_own on public.%I;', t, t);
    execute format(
      'create policy %I_select_own on public.%I for select using (user_id = auth.uid() or public.is_admin());',
      t, t
    );
    -- No INSERT/UPDATE/DELETE policies → only service_role can write.
  end loop;
end $$;

-- -------------------------------------------------------------------------
-- Admin-only tables.
-- -------------------------------------------------------------------------
alter table public.global_emergency_stop enable row level security;
drop policy if exists ges_admin_all on public.global_emergency_stop;
create policy ges_admin_all on public.global_emergency_stop
  for all using (public.is_admin()) with check (public.is_admin());

alter table public.feature_flags enable row level security;
drop policy if exists ff_admin_all on public.feature_flags;
create policy ff_admin_all on public.feature_flags
  for all using (public.is_admin()) with check (public.is_admin());
-- Read access for users to their own user-scoped flags.
drop policy if exists ff_user_select_own on public.feature_flags;
create policy ff_user_select_own on public.feature_flags
  for select using (scope = 'user' and user_id = auth.uid());

alter table public.partners enable row level security;
drop policy if exists partners_select_active on public.partners;
-- Anyone authenticated can list active partners (for the agency BM step).
create policy partners_select_active on public.partners
  for select using (status = 'active' or public.is_admin());
drop policy if exists partners_admin_all on public.partners;
create policy partners_admin_all on public.partners
  for all using (public.is_admin()) with check (public.is_admin());
