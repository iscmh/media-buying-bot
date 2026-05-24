-- Polish-6 item 8 (part 2): add columns that consume the new enum
-- value from migration 0026.

alter table public.generation_jobs
  add column if not exists detected_format               jsonb,
  add column if not exists picked_pipeline               text,
  add column if not exists reference_creative_storage_path text;

alter table public.generated_creatives
  add column if not exists clip_index     integer,
  add column if not exists is_clip_part   boolean not null default false;
