-- Polish-6 item 8: auto-detect winning creative format + auto-route.
--
-- New columns on generation_jobs:
--   detected_format (jsonb, nullable) — full vision detection output
--   picked_pipeline (text, nullable) — the auto-routed pipeline string
--   reference_creative_storage_path (text, nullable) — Supabase Storage
--     key for the user's uploaded reference creative (video or image)
--
-- New columns on generated_creatives:
--   clip_index (int, nullable) — for multi-clip Kling variants (0-15)
--   is_clip_part (boolean, default false) — distinguish sub-clip rows
--     from the final muxed/composite output
--
-- Also adds 'openai' to ai_provider enum (for Whisper + Sora keys).
--
-- Idempotent (IF NOT EXISTS / ADD VALUE IF NOT EXISTS).

do $$
begin
  alter type public.ai_provider add value if not exists 'openai';
exception when duplicate_object then null;
end $$;
