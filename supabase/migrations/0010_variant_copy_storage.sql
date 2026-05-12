-- Phase 3c: store variant copy strings + full Storage URLs on creatives.
--
-- Bug fixes addressed:
--   - file_url now stores the full Supabase public URL (was: relative path)
--   - new image_storage_path holds the raw object key for backend ops
--   - new headline / primary_text / description capture Claude's per-variant
--     copy (was: dropped on the floor — only INDEX columns existed)
--   - generation_metadata is a flex bag for provider response details,
--     prompt used, latencies, errors
--
-- Idempotent — safe to re-run.

alter table public.generated_creatives
  add column if not exists headline text;

alter table public.generated_creatives
  add column if not exists primary_text text;

alter table public.generated_creatives
  add column if not exists description text;

alter table public.generated_creatives
  add column if not exists image_storage_path text;

alter table public.generated_creatives
  add column if not exists generation_metadata jsonb default '{}'::jsonb;
