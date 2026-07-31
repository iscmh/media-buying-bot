-- Polish-25.7 Commit 46: first-party error tracking table.
--
-- Complementary to Sentry (both stay wired). Sentry gives us the
-- polished issue-tracker UX; error_log gives us admin-native
-- visibility inside the app and a source of truth we own if Sentry
-- goes down / hits quota.
--
-- Every server action wrapper, API route wrapper, Inngest worker
-- onFailure hook, client error boundary, and unhandled promise
-- handler writes here via packages/db/src/error-log.ts.
--
-- Retention: nightly cron deletes rows older than 90 days. See
-- packages/jobs/src/functions/cleanup-error-log.ts.

create table if not exists error_log (
  id uuid primary key default gen_random_uuid(),

  -- Nullable — some errors happen pre-auth or after logout.
  -- on delete SET NULL keeps the log row when a user is deleted.
  user_id uuid references public.users (id) on delete set null,

  -- Free-form because the enum shape will change as we add
  -- surfaces. Values written today:
  --   server_action / api_route / worker / client_render /
  --   client_boundary / unhandled_promise
  source text not null,
  source_name text,

  message text not null,
  stack text,

  context jsonb not null default '{}'::jsonb,
  breadcrumbs jsonb not null default '[]'::jsonb,

  -- error | warning | info
  severity text not null default 'error',

  -- SHA-1 hex of source + source_name + normalized message.
  -- Used by the /admin/errors "grouped" view for dedup.
  fingerprint text,

  created_at timestamptz not null default now()
);

create index if not exists error_log_created_at_idx on error_log (created_at desc);
create index if not exists error_log_user_created_at_idx on error_log (user_id, created_at desc);
create index if not exists error_log_fingerprint_created_at_idx on error_log (fingerprint, created_at desc);
create index if not exists error_log_source_created_at_idx on error_log (source, created_at desc);

-- RLS: admin-only select (via the users.role='admin' check), any
-- authenticated user can insert their own rows (client-side error
-- logger POSTs), service-role can insert unconditionally (server-
-- side + worker writes).
alter table error_log enable row level security;

drop policy if exists error_log_admin_select on error_log;
create policy error_log_admin_select on error_log
  for select
  to authenticated
  using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.role = 'admin'
    )
  );

drop policy if exists error_log_user_insert_own on error_log;
create policy error_log_user_insert_own on error_log
  for insert
  to authenticated
  with check (
    user_id is null or user_id = auth.uid()
  );

-- Service-role bypasses RLS by default; no explicit policy needed.

comment on table error_log is
  'Polish-25.7 Commit 46: first-party error tracking. Complements Sentry. 90-day retention.';
