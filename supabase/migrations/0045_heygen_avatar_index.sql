-- Polish-26 Commit 61: enriched HeyGen avatar index.
--
-- Direct mirror of supabase/migrations/0037_makeugc_avatar_index.sql
-- (see that file's header for the WHY — same rationale applies:
-- HeyGen's /v2/avatars endpoint returns { avatar_id, avatar_name,
-- gender, preview_image_url } — no ethnicity/age/hair/wardrobe —
-- so we cache Gemini vision descriptors here for persona-driven
-- matching in the polish26-heygen worker's avatar-match step.
--
-- Enum values are pinned to the same MAKEUGC_* enums (see
-- packages/jobs/src/lib/makeugc-avatar-vision-prompt.ts) because
-- the Gemini analyzer prompt is REUSED verbatim — an avatar
-- thumbnail is an avatar thumbnail; the person-classification
-- schema is provider-agnostic. Sharing the enum values keeps
-- the matcher code identical between the two providers.
--
-- Empty-index fallback: worker checks row count first. If zero
-- enriched rows exist (fresh deploy, refresh cron hasn't fired
-- yet), the worker falls back to live listHeygenAvatars() + a
-- gender-only match + loud-log the fallback. Same shape as the
-- MakeUGC pattern.

create table if not exists public.heygen_avatar_index (
  avatar_id text primary key,
  avatar_name text not null,
  thumbnail_url text not null,

  -- Raw HeyGen field (verbatim from the API response).
  heygen_gender text not null, -- "male" | "female" (HeyGen uses lowercase)

  -- Gemini vision extracted fields (SAME enums as makeugc_avatar_index).
  age_bucket text not null, -- "20s" | "30s" | ... | "80s+"
  ethnicity text not null,
  hair_color text not null,
  hair_style text,
  facial_hair text,
  wardrobe_style text,
  wardrobe_summary text,
  background_setting text,

  vision_analysis_raw jsonb,

  vision_analyzed_at timestamptz not null default now(),
  last_refreshed_at timestamptz not null default now(),
  first_seen_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Filter index for the matcher's HARD filter chain. Mirrors
-- makeugc_avatar_index_filter_idx.
create index if not exists heygen_avatar_index_filter_idx
  on public.heygen_avatar_index (heygen_gender, age_bucket, ethnicity)
  where deleted_at is null;

-- Stale-refresh scan: rows older than 7 days for next cron cycle.
create index if not exists heygen_avatar_index_stale_idx
  on public.heygen_avatar_index (last_refreshed_at)
  where deleted_at is null;

-- RLS intentionally NOT enabled — this is a shared library table.
-- Only the refresh cron writes; matcher reads are unrestricted.

comment on table public.heygen_avatar_index is
  'Polish-26 Commit 61: enriched HeyGen avatar library for persona matching. Mirrors makeugc_avatar_index shape + shares its Gemini vision prompt.';
