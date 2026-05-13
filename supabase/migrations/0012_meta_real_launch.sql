-- Phase 4b: real Meta auto-launch infrastructure.
--
-- Adds:
--   * meta_pages cache — one row per FB page the user authorized, refreshed
--     on settings load + via "Refresh pages" button. Stores page_access_token
--     encrypted via pgcrypto (same pattern as meta_connections).
--   * user_settings extensions:
--       - live_launch_acknowledged_at — gates the first-time triple-confirm
--         dialog (Phase 4b explicit opt-in beyond Phase 4a's single ack).
--       - live_launch_count — counter used to enforce the $10 first-launch
--         hard cap. Increments by 1 per successful live launch SESSION
--         (not per ad).
--       - default_page_id, default_targeting_countries, default_age_min/max
--         — pre-fill the launch dialog so most launches are 1-click.
--
-- Idempotent. Safe to re-run.

-- =========================================================================
-- 1. meta_pages cache
-- =========================================================================
create table if not exists public.meta_pages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  page_id text not null,
  page_name text not null,
  -- Some Marketing-API endpoints require a page access token (different
  -- from the user access token). Long-lived once exchanged. Encrypted.
  page_access_token_encrypted text,
  category text,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, page_id)
);

create index if not exists idx_meta_pages_user on public.meta_pages(user_id);

drop trigger if exists set_updated_at on public.meta_pages;
create trigger set_updated_at
  before update on public.meta_pages
  for each row execute function public.tg_set_updated_at();

alter table public.meta_pages enable row level security;

drop policy if exists meta_pages_select_own on public.meta_pages;
create policy meta_pages_select_own on public.meta_pages
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists meta_pages_insert_own on public.meta_pages;
create policy meta_pages_insert_own on public.meta_pages
  for insert with check (user_id = auth.uid() or public.is_admin());

drop policy if exists meta_pages_update_own on public.meta_pages;
create policy meta_pages_update_own on public.meta_pages
  for update using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

drop policy if exists meta_pages_delete_own on public.meta_pages;
create policy meta_pages_delete_own on public.meta_pages
  for delete using (user_id = auth.uid() or public.is_admin());

-- =========================================================================
-- 2. user_settings extensions — live launch ack + first-launch counter
--    + Meta targeting defaults.
-- =========================================================================
alter table public.user_settings
  add column if not exists live_launch_acknowledged_at timestamptz;

alter table public.user_settings
  add column if not exists live_launch_count integer not null default 0;

alter table public.user_settings
  add column if not exists default_page_id text;

alter table public.user_settings
  add column if not exists default_targeting_countries text[]
  not null default array['US']::text[];

alter table public.user_settings
  add column if not exists default_age_min integer not null default 18;

alter table public.user_settings
  add column if not exists default_age_max integer not null default 65;
