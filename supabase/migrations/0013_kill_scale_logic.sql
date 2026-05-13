-- Phase 5: kill/scale logic infrastructure.
--
-- Adds:
--   * launched_ads kill/scale tracking columns
--   * user_settings: kill/scale threshold knobs + first-time ack flags
--     + polling cadence + scale_success_count counter (drives the
--     first-5-scales +25% cap)
--   * pending_approvals: row per kill/scale prompt awaiting user tap
--     in Telegram. status='pending'|'confirmed'|'skipped'|'expired',
--     24-hour expires_at default.
--
-- Idempotent.

-- =========================================================================
-- 1. launched_ads — kill/scale tracking
-- =========================================================================
alter table public.launched_ads
  add column if not exists kill_recommended_at timestamptz,
  add column if not exists kill_recommended_reason text,
  add column if not exists kill_confirmed_at timestamptz,
  add column if not exists scale_recommended_at timestamptz,
  add column if not exists scale_recommended_to_usd numeric(10, 2),
  add column if not exists scale_recommended_reason text,
  add column if not exists scale_confirmed_at timestamptz,
  add column if not exists scale_count integer not null default 0,
  add column if not exists last_scaled_at timestamptz;

-- =========================================================================
-- 2. user_settings — kill/scale thresholds + ack flags + counters
-- =========================================================================
alter table public.user_settings
  add column if not exists kill_acknowledged_at timestamptz,
  add column if not exists scale_acknowledged_at timestamptz,
  -- Kill triggers. Defaults: kill if CPC > $5 OR no conv after $10 spend
  -- OR CTR < 0.5% (with 1000+ impressions to avoid early noise).
  add column if not exists kill_max_cpc_usd numeric(10, 2) not null default 5.00,
  add column if not exists kill_no_conv_spend_usd numeric(10, 2) not null default 10.00,
  add column if not exists kill_min_ctr_pct numeric(5, 2) not null default 0.50,
  -- Scale triggers. Defaults: ROAS >= 2.0 and spend >= $20 before scaling.
  -- ROAS is heuristic in Phase 5 (assumed value per conversion); Phase 6
  -- will read action_values from Meta /insights once Pixel is wired.
  add column if not exists scale_min_roas numeric(5, 2) not null default 2.00,
  add column if not exists scale_min_spend_usd numeric(10, 2) not null default 20.00,
  add column if not exists scale_increment_pct numeric(5, 2) not null default 50.00,
  add column if not exists scale_max_daily_budget_usd numeric(10, 2) not null default 100.00,
  add column if not exists polling_interval_minutes integer not null default 30,
  -- Counter feeding the first-5-scales +25% cap (Phase 5 hardcoded safety).
  add column if not exists scale_success_count integer not null default 0;

-- =========================================================================
-- 3. pending_approvals — Telegram-asked kill/scale prompts
-- =========================================================================
create table if not exists public.pending_approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  launched_ad_id uuid not null references public.launched_ads(id) on delete cascade,

  action_type text not null check (action_type in ('kill', 'scale')),
  -- Free-form payload. For scale: { new_budget_usd: 3.00, from_budget_usd: 2.00 }.
  -- For kill: {}.
  proposed_payload jsonb not null default '{}'::jsonb,
  reason text not null,

  -- Telegram message id the prompt was posted as. Stored as text so we
  -- never lose precision on JS-side BigInt vs Number conversions — same
  -- pattern as telegram_connections.tg_chat_id.
  telegram_message_id text,

  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'skipped', 'expired')),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  responded_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_pending_approvals_user_status
  on public.pending_approvals(user_id, status);
create index if not exists idx_pending_approvals_telegram_msg
  on public.pending_approvals(telegram_message_id);

drop trigger if exists set_updated_at on public.pending_approvals;
create trigger set_updated_at
  before update on public.pending_approvals
  for each row execute function public.tg_set_updated_at();

alter table public.pending_approvals enable row level security;

drop policy if exists pending_approvals_select_own on public.pending_approvals;
create policy pending_approvals_select_own on public.pending_approvals
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists pending_approvals_insert_own on public.pending_approvals;
create policy pending_approvals_insert_own on public.pending_approvals
  for insert with check (user_id = auth.uid() or public.is_admin());

drop policy if exists pending_approvals_update_own on public.pending_approvals;
create policy pending_approvals_update_own on public.pending_approvals
  for update using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());
