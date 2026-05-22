-- Polish-5: cached performance snapshot on launched_ads.
--
-- The poll-ad-performance worker fetches insights from Meta but the
-- /launched UI + kill/scale evaluator (eventually) want a stable
-- "current snapshot" surface separate from the existing meta_* columns
-- (which were Phase-5 placeholders without precise semantics).
--
-- New columns sit alongside the existing meta_* fields; the existing
-- fields stay populated for back-compat. Migration is additive.
--
-- current_window_kind names the window the snapshot covers (typically
-- 'last_7d' — what the poll uses today). Future evaluator logic can
-- branch on it ("evaluate kill rules only on last_30min").
--
-- Index on status accelerates the launched_ads list filter once we
-- archive stale rows in migration 0022.

alter table public.launched_ads
  add column if not exists current_spend         numeric(10,2),
  add column if not exists current_impressions   integer,
  add column if not exists current_clicks        integer,
  add column if not exists current_ctr           numeric(8,4),
  add column if not exists current_cpc           numeric(10,4),
  add column if not exists current_conversions   integer,
  add column if not exists current_frequency     numeric(8,4),
  add column if not exists current_window_kind   text default 'lifetime';

create index if not exists launched_ads_status_idx on public.launched_ads (status);
