-- Polish-23 Commit 3.0.19: `metadata jsonb` on concepts so vision
-- analysis (persona / setting / emotional arc / hook / niche) can
-- persist ONCE per concept and be reused across N Polish-23 jobs
-- against the same source video. Prior to this migration, analysis
-- lived on generation_jobs.metadata — every new job either re-ran
-- Gemini Vision OR fell back to a lookup across prior completed
-- jobs (Commit 3.0.10 pattern). concepts.metadata is the canonical
-- resting place.
--
-- Empty default so existing rows survive the ADD without touching
-- application code paths that don't know about the column.
alter table public.concepts
  add column if not exists metadata jsonb not null default '{}'::jsonb;
