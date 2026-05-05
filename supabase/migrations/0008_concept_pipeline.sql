-- Phase 3a: concept pipeline infrastructure.
--
-- Extends:
--   * concepts: niche/source/offer metadata + static copy fields + UGC script
--   * generation_jobs: intensity/variant_count/provider/cost columns + mode flag
--   * user_settings: ai_generation_daily_cap_usd
--   * creative_status enum: ready_for_review, approved
--   * concepts bucket allowed MIME types: add image/* (was video-only)
--
-- New tables:
--   * tool_connections: Gemini / Claude / Kie.ai BYOK keys (separate from
--     ai_provider_connections which holds Arcads/HeyGen/Creatify UGC video
--     credentials). Schema split per Phase 3a spec; the UGC-video provider
--     picker reads from BOTH tables (Kie.ai from this one, HeyGen/Arcads
--     from ai_provider_connections).
--
-- Idempotent: every change is gated on `if not exists` / `if exists` /
-- `do $$ ... exception when duplicate ... end $$` blocks. Safe to re-run.

-- =========================================================================
-- 1. concepts: metadata + static + UGC fields
-- =========================================================================
alter table public.concepts add column if not exists niche_tag text;
alter table public.concepts add column if not exists source_platform text;
alter table public.concepts
  drop constraint if exists concepts_source_platform_check;
alter table public.concepts add constraint concepts_source_platform_check
  check (source_platform is null or source_platform in ('meta', 'tiktok', 'youtube', 'other'));

alter table public.concepts add column if not exists offer_url text;
alter table public.concepts add column if not exists original_cpa_usd numeric(10,2);
alter table public.concepts add column if not exists original_roas numeric(10,2);

-- Static-only ad copy fields (NULL for UGC concepts).
alter table public.concepts add column if not exists static_headline text;
alter table public.concepts add column if not exists static_primary_text text;
alter table public.concepts add column if not exists static_description text;

-- UGC-only original script (NULL for static concepts).
alter table public.concepts add column if not exists ugc_original_script text;

-- =========================================================================
-- 2. generation_jobs: request shape + mode + cost
-- =========================================================================

-- Phase 1 marked ai_provider_used as NOT NULL for UGC-provider scoping.
-- Phase 3a static jobs use Gemini + Claude (which live in tool_connections,
-- not ai_provider_connections), so the legacy column doesn't apply. Loosen
-- to NULL — static jobs leave it null, UGC jobs populate it.
alter table public.generation_jobs alter column ai_provider_used drop not null;

alter table public.generation_jobs add column if not exists intensity text;
alter table public.generation_jobs
  drop constraint if exists generation_jobs_intensity_check;
alter table public.generation_jobs add constraint generation_jobs_intensity_check
  check (intensity is null or intensity in ('small', 'medium', 'big'));

alter table public.generation_jobs add column if not exists variant_count integer;
alter table public.generation_jobs
  drop constraint if exists generation_jobs_variant_count_check;
alter table public.generation_jobs add constraint generation_jobs_variant_count_check
  check (variant_count is null or (variant_count > 0 and variant_count <= 100));

alter table public.generation_jobs add column if not exists provider_choice text;
alter table public.generation_jobs add column if not exists estimated_cost_usd numeric(10,4);
alter table public.generation_jobs add column if not exists actual_cost_usd numeric(10,4);

alter table public.generation_jobs add column if not exists mode text default 'mock';
alter table public.generation_jobs
  drop constraint if exists generation_jobs_mode_check;
alter table public.generation_jobs add constraint generation_jobs_mode_check
  check (mode is null or mode in ('mock', 'live'));

-- Free-form metadata blob: where the analyze-concept job stuffs its mock
-- structured analysis output. Phase 3b will replace mock JSON with real
-- Gemini Vision output here.
alter table public.generation_jobs add column if not exists metadata jsonb;

-- =========================================================================
-- 3. user_settings: AI generation daily cap
-- =========================================================================
alter table public.user_settings
  add column if not exists ai_generation_daily_cap_usd numeric(10,2)
  not null default 50.00;

-- =========================================================================
-- 4. enum extensions
-- =========================================================================
-- creative_status: states for the variant review flow
do $$
begin
  alter type public.creative_status add value if not exists 'ready_for_review';
exception when duplicate_object then null;
end $$;
do $$
begin
  alter type public.creative_status add value if not exists 'approved';
exception when duplicate_object then null;
end $$;

-- concept_content_type: Phase 1 had ('video', 'text') for the uploaded-vs-
-- text-only split. Phase 3a uses ('static', 'ugc') for the image-with-copy-
-- vs-video split. Add the new values; the legacy 'video'/'text' rows (if
-- any) stay valid.
do $$
begin
  alter type public.concept_content_type add value if not exists 'static';
exception when duplicate_object then null;
end $$;
do $$
begin
  alter type public.concept_content_type add value if not exists 'ugc';
exception when duplicate_object then null;
end $$;

-- =========================================================================
-- 5. tool_connections: Gemini / Claude / Kie.ai BYOK
-- =========================================================================
do $$
begin
  create type public.tool_provider as enum ('gemini', 'claude', 'kie_ai');
exception when duplicate_object then null;
end $$;

create table if not exists public.tool_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider public.tool_provider not null,
  api_key_encrypted text not null,
  api_key_verified_at timestamptz,
  status text not null default 'pending',
  last_used_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active row per (user, provider). Non-deleted rows are unique;
-- soft-deleted rows can stack (history of past connections).
create unique index if not exists uq_tool_connections_user_provider_active
  on public.tool_connections(user_id, provider)
  where deleted_at is null;

create index if not exists idx_tool_connections_user
  on public.tool_connections(user_id);

-- updated_at trigger (Phase 1's loop in 0003_triggers ran once at install
-- time, so we manually wire the trigger for tables added later).
drop trigger if exists set_updated_at on public.tool_connections;
create trigger set_updated_at
  before update on public.tool_connections
  for each row execute function public.tg_set_updated_at();

-- RLS — same pattern as ai_provider_connections from Phase 1.
alter table public.tool_connections enable row level security;

drop policy if exists tool_connections_select_own on public.tool_connections;
create policy tool_connections_select_own on public.tool_connections
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists tool_connections_insert_own on public.tool_connections;
create policy tool_connections_insert_own on public.tool_connections
  for insert with check (user_id = auth.uid() or public.is_admin());

drop policy if exists tool_connections_update_own on public.tool_connections;
create policy tool_connections_update_own on public.tool_connections
  for update using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

drop policy if exists tool_connections_delete_own on public.tool_connections;
create policy tool_connections_delete_own on public.tool_connections
  for delete using (user_id = auth.uid() or public.is_admin());

-- =========================================================================
-- 6. Storage: concepts bucket needs image MIME types for static uploads
-- =========================================================================
update storage.buckets
set allowed_mime_types = array[
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'image/png',
  'image/jpeg',
  'image/webp'
]
where id = 'concepts';

-- generated-creatives already accepts video/mp4 + image/png + image/jpeg
-- per 0006_storage_buckets.sql; no change needed there for Phase 3a mock
-- output (we generate placehold.co URLs, not real files).
