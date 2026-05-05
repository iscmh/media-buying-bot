-- Phase 3b: live AI generation infrastructure.
--
-- Extends:
--   * user_settings: live_generation_acknowledged_at — gate that flips
--     true the first time a user confirms the "this will spend real money"
--     dialog. Subsequent live submissions skip the dialog.
--
-- New tables:
--   * ai_provider_api_call_logs — audit log for every Gemini/Claude/Kie.ai/
--     HeyGen call. Same shape as Phase 1's meta_api_call_logs plus a
--     `provider` discriminator and `cost_usd`. Required for liability +
--     debugging when a real generation lands wrong.
--
-- Idempotent. Safe to re-run.

-- =========================================================================
-- 1. user_settings: live mode acknowledgment timestamp
-- =========================================================================
alter table public.user_settings
  add column if not exists live_generation_acknowledged_at timestamptz;

-- =========================================================================
-- 2. ai_provider_api_call_logs: per-call audit + cost tracking
-- =========================================================================
create table if not exists public.ai_provider_api_call_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,

  -- 'gemini' | 'claude' | 'kie_ai' | 'heygen' | 'arcads' | 'creatify'.
  -- Free-form text rather than enum so adding a provider is a code change,
  -- not a schema migration.
  provider text not null,

  endpoint text not null,
  method text not null,

  -- Sanitized: API keys stripped, large media payloads excerpted before
  -- write.
  request_body_sanitized jsonb not null default '{}'::jsonb,
  response_status integer,
  response_body_excerpt jsonb,

  latency_ms integer,
  cost_usd numeric(10, 4),

  -- Optional link to the generation_jobs row this call was part of, for
  -- per-job cost rollup queries.
  generation_job_id uuid references public.generation_jobs(id) on delete set null,

  -- Optional link to the variant created by this call.
  generated_creative_id uuid references public.generated_creatives(id) on delete set null,

  called_at timestamptz not null default now()
);

create index if not exists idx_aipac_user_called
  on public.ai_provider_api_call_logs(user_id, called_at desc);

create index if not exists idx_aipac_job
  on public.ai_provider_api_call_logs(generation_job_id)
  where generation_job_id is not null;

create index if not exists idx_aipac_provider_status
  on public.ai_provider_api_call_logs(provider, response_status);

-- RLS: user reads own logs; service-role writes (jobs run server-side).
alter table public.ai_provider_api_call_logs enable row level security;

drop policy if exists ai_provider_api_call_logs_select_own
  on public.ai_provider_api_call_logs;
create policy ai_provider_api_call_logs_select_own
  on public.ai_provider_api_call_logs
  for select using (user_id = auth.uid() or public.is_admin());

-- No INSERT/UPDATE/DELETE policies — service-role only writes.
