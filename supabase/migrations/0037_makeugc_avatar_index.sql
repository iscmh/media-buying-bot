-- Polish-25 Commit 7: enriched MakeUGC avatar index.
--
-- MakeUGC's /video/avatars endpoint returns only { id, name,
-- thumbnail, gender } — not enough for persona-driven matching.
-- Commit 1's matcher can only hard-filter on gender; a source
-- persona of "male 60s white gray hair" routinely gets bound to a
-- 30s male avatar because the API surface can't disambiguate.
--
-- This table caches Gemini Vision descriptors (age bucket,
-- ethnicity, hair, wardrobe, facial hair, background) for every
-- MakeUGC avatar. A nightly Inngest cron (refresh-makeugc-avatar-
-- index) analyzes new + stale (>7 days) rows and upserts the
-- enriched descriptors here; the polish25-makeugc worker joins
-- against this table when picking an avatar.
--
-- Empty-index fallback: worker checks row count first. If the
-- index has NEVER been populated (fresh deploy, migration ran but
-- refresh cron hasn't fired), the worker falls back to Commit 1's
-- gender-only matcher and loud-logs the fallback.
--
-- Soft delete: deletedAt nullable so we can flag avatars that
-- disappeared from MakeUGC's library on a refresh cycle without
-- losing the enriched history (in case they come back — some
-- vendors rotate their public library).

create table if not exists public.makeugc_avatar_index (
  avatar_id text primary key,
  avatar_name text not null,
  thumbnail_url text not null,

  -- Raw MakeUGC field (verbatim from the API response).
  makeugc_gender text not null, -- "Male" | "Female"

  -- Gemini Vision extracted fields.
  age_bucket text not null, -- "20s" | "30s" | "40s" | "50s" |
                             -- "60s" | "70s" | "80s+"
  ethnicity text not null, -- "white" | "black" | "asian" |
                            -- "hispanic" | "latino" |
                            -- "middle_eastern" | "mixed" | "other"
  hair_color text not null, -- "black" | "brown" | "blonde" |
                             -- "gray" | "white" | "red" |
                             -- "bald" | "other"
  hair_style text, -- optional descriptor
  facial_hair text, -- "clean_shaven" | "stubble" |
                     -- "mustache" | "beard" | "goatee"
  wardrobe_style text, -- "casual" | "business_casual" |
                        -- "formal" | "athletic" |
                        -- "creative" | "other"
  wardrobe_summary text, -- freeform 1-sentence description
  background_setting text, -- "studio" | "indoor_home" |
                            -- "indoor_office" | "outdoor" |
                            -- "neutral" | "other"

  -- Full Gemini response for audit + future re-parse if the
  -- Zod schema evolves without a re-vision-analyze cycle.
  vision_analysis_raw jsonb,

  -- When Gemini last analyzed the thumbnail.
  vision_analyzed_at timestamptz not null default now(),
  -- When the refresh cron last confirmed the row was current
  -- (touched on every refresh cycle even if no vision re-analyze
  -- happened — used by the >7d stale filter).
  last_refreshed_at timestamptz not null default now(),
  -- When we first saw this avatar in the MakeUGC library.
  first_seen_at timestamptz not null default now(),
  -- Set when a refresh cycle no longer sees this avatar in
  -- listMakeugcAvatars. Nullable so re-appearing avatars can be
  -- un-deleted without losing history.
  deleted_at timestamptz
);

-- Filter index for the matcher's HARD filter chain.
-- (makeugc_gender, age_bucket, ethnicity) is the natural read
-- pattern — narrow by gender first, age second, tiebreak on
-- ethnicity.
create index if not exists makeugc_avatar_index_filter_idx
  on public.makeugc_avatar_index (makeugc_gender, age_bucket, ethnicity)
  where deleted_at is null;

-- Stale-refresh scan: find rows older than 7 days that need
-- re-analysis on the next cron cycle.
create index if not exists makeugc_avatar_index_stale_idx
  on public.makeugc_avatar_index (last_refreshed_at)
  where deleted_at is null;

-- RLS is intentionally NOT enabled — this is a shared library
-- table (not per-user data). Application-level access controls
-- gate write paths (only the refresh worker + admin path can
-- write; reads are unrestricted for the matcher).
