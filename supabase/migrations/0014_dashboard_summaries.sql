-- Phase 6: P&L dashboard + daily Telegram summaries.
--
-- The daily_summaries table existed since Phase 1 (powering the spend-
-- safety daily-spend check). Phase 6 EXTENDS it with the Phase-6
-- aggregate columns + a unique (user_id, summary_date) constraint to
-- guarantee idempotent cron writes. Existing columns
-- (date, spend, revenue, profit, roi, conversions, cpa,
-- top_performer_ad_id) are preserved so spend-safety keeps working
-- unchanged.
--
-- Note: the migration uses the legacy `date` column name as the per-day
-- key (Phase-1 chose that name); the Phase-6 spec uses summary_date
-- internally but stores both as the same column.
--
-- Idempotent. Safe to re-run.

-- =========================================================================
-- 1. daily_summaries — Phase-6 column additions
-- =========================================================================
alter table public.daily_summaries
  add column if not exists ads_active_count integer not null default 0,
  add column if not exists ads_launched_count integer not null default 0,
  add column if not exists ads_killed_count integer not null default 0,
  add column if not exists ads_scaled_count integer not null default 0;

alter table public.daily_summaries
  add column if not exists total_clicks integer not null default 0,
  add column if not exists total_impressions integer not null default 0,
  add column if not exists avg_cpc_usd numeric(10, 2),
  add column if not exists avg_ctr_pct numeric(5, 2),
  add column if not exists implied_roas numeric(10, 2);

alter table public.daily_summaries
  add column if not exists best_performing_ad_id uuid
    references public.launched_ads(id) on delete set null,
  add column if not exists worst_performing_ad_id uuid
    references public.launched_ads(id) on delete set null;

alter table public.daily_summaries
  add column if not exists telegram_sent_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

-- Unique (user_id, date) — required for ON CONFLICT DO NOTHING in the
-- cron's idempotent upsert. ADD CONSTRAINT IF NOT EXISTS isn't
-- supported pre-PG16, swallow duplicate_object.
do $$
begin
  alter table public.daily_summaries
    add constraint daily_summaries_user_date_unique unique (user_id, date);
exception when duplicate_object then null;
end $$;

-- Updated-at trigger so manual edits track time-of-edit. Reuses the
-- shared tg_set_updated_at function from migration 0003.
drop trigger if exists set_updated_at on public.daily_summaries;
create trigger set_updated_at
  before update on public.daily_summaries
  for each row execute function public.tg_set_updated_at();

-- =========================================================================
-- 2. user_settings — enable flag + send-hour
-- =========================================================================
alter table public.user_settings
  add column if not exists daily_summary_enabled boolean not null default true;

alter table public.user_settings
  add column if not exists daily_summary_hour_local integer not null default 9;

do $$
begin
  alter table public.user_settings
    add constraint daily_summary_hour_valid
    check (daily_summary_hour_local >= 0 and daily_summary_hour_local <= 23);
exception when duplicate_object then null;
end $$;
