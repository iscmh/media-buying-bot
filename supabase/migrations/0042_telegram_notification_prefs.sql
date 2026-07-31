-- Polish-25.8 Commit 48: per-user Telegram notification preferences.
--
-- Stored as jsonb on telegram_connections so we don't need a separate
-- table for what's fundamentally per-connection config. Defaults
-- match the "all alerts on, compact format, 9am daily summary, no
-- quiet hours" beta profile — operator opts *out* of noise, not in.
--
-- Also adds telegram_conversation_state for grammy multi-turn state
-- (e.g. /launch → pick variant → set budget → confirm). Lambda cold-
-- start would lose in-memory session state, so state persists here.

alter table telegram_connections
  add column if not exists notification_preferences jsonb
    not null
    default '{
      "daily_summary_enabled": true,
      "daily_summary_hour_local": 9,
      "weekly_rollup_enabled": true,
      "kill_alerts_enabled": true,
      "scale_alerts_enabled": true,
      "rejection_alerts_enabled": true,
      "threshold_breach_alerts_enabled": true,
      "quiet_hours_enabled": false,
      "quiet_hours_start_local": 22,
      "quiet_hours_end_local": 8,
      "summary_format": "compact"
    }'::jsonb;

create table if not exists telegram_conversation_state (
  user_id uuid primary key references public.users (id) on delete cascade,
  tg_chat_id text not null,
  -- Free-form state; commands stash their in-progress data here.
  -- Command examples: 'launch:pick_variant', 'launch:pick_budget',
  -- 'settings:pick_field'.
  state text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists telegram_conversation_state_updated_at_idx
  on telegram_conversation_state (updated_at desc);

comment on column telegram_connections.notification_preferences is
  'Polish-25.8 Commit 48: per-user Telegram notification prefs.';
comment on table telegram_conversation_state is
  'Polish-25.8 Commit 48: multi-turn bot state (15-min TTL enforced in @mbb/db).';
