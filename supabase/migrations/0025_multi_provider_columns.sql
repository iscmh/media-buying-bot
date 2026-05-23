-- Polish-4 (part 2 of 2): per-provider tier + metadata + format columns.
--
-- 1. ai_provider_connections additions:
--    - tier (nullable provider_tier) — HeyGen 'free'/'pro'/'premium';
--      other providers leave null
--    - last_verified_at — re-verify checkpoint (distinct from
--      api_key_verified_at, which is set on initial verify). The
--      "verify connection" button updates this on each re-check.
--    - metadata — flex jsonb for provider-specific cached state
--      (e.g. HeyGen.cached_avatar_count, kling.last_model_id)
--
-- 2. Partial unique index enforces "only one is_primary=true per user".
--    Existing code already sets isPrimary on connect; the constraint
--    prevents two concurrent connects from both winning the primary
--    flag.
--
-- 3. generation_jobs.format + generated_creatives.format track which
--    creative format the job/variant uses: 'avatar_talking_head'
--    (HeyGen) or 'cinematic_voiceover' (Kling). text not enum so
--    future formats don't need a migration round-trip.
--
-- Idempotent (IF NOT EXISTS everywhere).

alter table public.ai_provider_connections
  add column if not exists tier              public.provider_tier,
  add column if not exists last_verified_at  timestamptz,
  add column if not exists metadata          jsonb not null default '{}'::jsonb;

create unique index if not exists ai_provider_connections_primary_unique
  on public.ai_provider_connections (user_id)
  where is_primary = true and deleted_at is null;

alter table public.generation_jobs
  add column if not exists format text not null default 'avatar_talking_head';

alter table public.generated_creatives
  add column if not exists format text not null default 'avatar_talking_head';

create index if not exists generated_creatives_format_idx
  on public.generated_creatives (format);
