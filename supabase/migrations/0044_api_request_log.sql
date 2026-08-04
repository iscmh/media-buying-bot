-- Polish-25.10 Commit 59: per-request log powering the 60/min
-- sliding-window rate limiter and providing a basic audit trail
-- for API usage.
--
-- Sliding-window math:
--   SELECT count(*) FROM api_request_log
--   WHERE api_key_id = $1 AND created_at > now() - interval '60 seconds'
-- Cheap given the (api_key_id, created_at desc) index.
--
-- Retention: prune rows older than 7 days via an Inngest cron
-- (analogous to error_log retention). Not enforced at the DB level
-- yet — the daily audit will spot table bloat if the cron fails.

create table if not exists api_request_log (
  id uuid primary key default gen_random_uuid (),
  api_key_id uuid not null references public.api_keys (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  method text not null,
  path text not null,
  status_code integer not null,
  created_at timestamptz not null default now()
);

create index if not exists api_request_log_key_created_idx
  on api_request_log (api_key_id, created_at desc);
create index if not exists api_request_log_user_created_idx
  on api_request_log (user_id, created_at desc);

alter table api_request_log enable row level security;

create policy api_request_log_select_own on api_request_log for
select
  using (
    user_id = auth.uid ()
    or exists (
      select
        1
      from
        public.users u
      where
        u.id = auth.uid ()
        and u.role = 'admin'
    )
  );

comment on table api_request_log is
  'Polish-25.10 Commit 59: audit + rate-limit source for /api/v1 requests. Retention 7d (cleanup cron TODO).';
