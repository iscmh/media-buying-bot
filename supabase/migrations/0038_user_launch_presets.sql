-- Polish-25.2 Commit 16b: user launch presets.
--
-- Before this migration every launch dialog re-configured the same
-- five inline fields from userSettings defaults (countries, age
-- range, optimization goal, placement type, per-ad daily budget).
-- Operators running multiple offers wanted a "preset" quick-pick:
-- save the current form values as a named preset, apply it on the
-- next launch dialog without hunting through Settings.
--
-- Fields (matches what the launch dialog currently exposes):
--   * name              — user-visible label ("US Cold — $20/day")
--   * countries         — Meta targeting country codes
--   * age_min/age_max   — Meta age range
--   * optimization_goal — CONVERSIONS / LINK_CLICKS / ...
--   * placement_type    — advantage_plus / manual / ...
--   * per_ad_daily_budget_usd — matches userSettings.default_ad_daily_budget_usd
--
-- Not stored on the preset (per-concept / per-launch things):
--   * offer_url — belongs to the concept, not the preset
--   * page_id   — user picks from the cached list at launch time
--
-- MVP scope: CRUD only. No preset-usage counter, no "last used",
-- no default-preset flag. Add if operators actually want them.
--
-- RLS follows the standard per-user-owned pattern from 0004_rls.sql
-- (select/insert/update/delete _own). Included here rather than
-- appended to 0004 because 0004 iterates a hardcoded list — safer
-- to inline this table's policies with its schema.

create table if not exists public.user_launch_presets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,

  name text not null,

  -- Targeting.
  targeting_countries text[] not null default array['US']::text[],
  age_min integer not null default 18,
  age_max integer not null default 65,

  -- Optimization / placement / budget.
  optimization_goal text not null default 'CONVERSIONS',
  placement_type text not null default 'advantage_plus',
  per_ad_daily_budget_usd numeric(10, 2) not null default '10.00',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Sanity constraints. Age range MUST be Meta-valid.
  constraint user_launch_presets_age_min_check check (age_min between 13 and 65),
  constraint user_launch_presets_age_max_check check (age_max between 13 and 65),
  constraint user_launch_presets_age_order_check check (age_min <= age_max),
  constraint user_launch_presets_budget_check check (per_ad_daily_budget_usd > 0)
);

-- Per-user preset list is small (a handful per operator). Index on
-- user_id supports the /settings/presets list query. Unique on
-- (user_id, name) keeps the "duplicate preset" error at the DB level
-- so the server action doesn't need a pre-flight existence check.
create index if not exists user_launch_presets_user_id_idx
  on public.user_launch_presets (user_id);

create unique index if not exists user_launch_presets_user_id_name_uniq
  on public.user_launch_presets (user_id, lower(name));

alter table public.user_launch_presets enable row level security;

drop policy if exists user_launch_presets_select_own on public.user_launch_presets;
create policy user_launch_presets_select_own on public.user_launch_presets
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists user_launch_presets_insert_own on public.user_launch_presets;
create policy user_launch_presets_insert_own on public.user_launch_presets
  for insert with check (user_id = auth.uid() or public.is_admin());

drop policy if exists user_launch_presets_update_own on public.user_launch_presets;
create policy user_launch_presets_update_own on public.user_launch_presets
  for update using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

drop policy if exists user_launch_presets_delete_own on public.user_launch_presets;
create policy user_launch_presets_delete_own on public.user_launch_presets
  for delete using (user_id = auth.uid() or public.is_admin());
