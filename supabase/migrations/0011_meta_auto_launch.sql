-- Phase 4a: Meta auto-launch infrastructure (DRY_RUN mode).
--
-- Adds:
--   * launched_ad_status enum
--   * launched_ads table — one row per Meta ad we attempted to launch.
--     Stores Meta IDs (or dry_run_<uuid> placeholders), launch config,
--     status, and Phase-5 performance columns reserved for the future
--     poller.
--   * user_settings: launch_acknowledged_at + 4 new launch-default
--     columns (daily cap, per-ad default budget, optimization goal,
--     placement type).
--   * creative_status enum: 'launch_failed' (the 'launched' value
--     already existed pre-Phase-4a).
--
-- Idempotent. Safe to re-run.

-- =========================================================================
-- 1. launched_ad_status enum
-- =========================================================================
do $$
begin
  create type public.launched_ad_status as enum (
    'dry_run',
    'active',
    'paused',
    'killed',
    'rejected_by_meta',
    'launch_failed'
  );
exception when duplicate_object then null;
end $$;

-- =========================================================================
-- 2. launched_ads table
-- =========================================================================
create table if not exists public.launched_ads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  generated_creative_id uuid not null references public.generated_creatives(id),
  generation_job_id uuid references public.generation_jobs(id) on delete set null,
  concept_id uuid references public.concepts(id) on delete set null,

  -- Meta object IDs (placeholders prefixed dry_run_ when mode='mock').
  meta_campaign_id text,
  meta_ad_set_id text,
  meta_creative_id text,
  meta_ad_id text,

  -- Per-ad daily budget at launch time (USD). Drives cap math.
  daily_budget_usd numeric(10, 2) not null,
  optimization_goal text not null,
  placement_type text not null,

  status public.launched_ad_status not null default 'dry_run',
  mode text not null default 'mock' check (mode in ('mock', 'live')),
  error_message text,

  launched_at timestamptz not null default now(),
  paused_at timestamptz,
  killed_at timestamptz,

  -- Phase 5 fields — poller fills these in.
  last_polled_at timestamptz,
  meta_spend_usd numeric(10, 2),
  meta_impressions integer,
  meta_clicks integer,
  meta_conversions integer,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_launched_ads_user_status
  on public.launched_ads(user_id, status);
create index if not exists idx_launched_ads_user_launched
  on public.launched_ads(user_id, launched_at desc);

drop trigger if exists set_updated_at on public.launched_ads;
create trigger set_updated_at
  before update on public.launched_ads
  for each row execute function public.tg_set_updated_at();

alter table public.launched_ads enable row level security;

drop policy if exists launched_ads_select_own on public.launched_ads;
create policy launched_ads_select_own on public.launched_ads
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists launched_ads_insert_own on public.launched_ads;
create policy launched_ads_insert_own on public.launched_ads
  for insert with check (user_id = auth.uid() or public.is_admin());

drop policy if exists launched_ads_update_own on public.launched_ads;
create policy launched_ads_update_own on public.launched_ads
  for update using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- =========================================================================
-- 3. user_settings: launch acknowledgment + launch defaults
-- =========================================================================
alter table public.user_settings
  add column if not exists launch_acknowledged_at timestamptz;

alter table public.user_settings
  add column if not exists daily_launch_budget_cap_usd numeric(10, 2)
  not null default 50.00;

alter table public.user_settings
  add column if not exists default_ad_daily_budget_usd numeric(10, 2)
  not null default 10.00;

alter table public.user_settings
  add column if not exists default_optimization_goal text
  not null default 'CONVERSIONS';

alter table public.user_settings
  add column if not exists default_placement_type text
  not null default 'advantage_plus';

-- =========================================================================
-- 4. creative_status enum: 'launch_failed' (pre-3c had 'launched' already)
-- =========================================================================
-- ALTER TYPE ADD VALUE has IF NOT EXISTS in PG12+. We swallow the
-- duplicate_object error for older instances.
do $$
begin
  alter type public.creative_status add value if not exists 'launch_failed';
exception when duplicate_object then null;
end $$;
