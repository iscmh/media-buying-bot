-- Phase 3f — HeyGen Avatar Mode pipeline.
--
-- The UGC variant pipeline now defaults to HeyGen's text-to-video avatar
-- generation (Sora 2 / Kie.ai retained but unused). Each user picks a
-- default avatar in /settings; the pipeline reads it on every generation.
-- HEYGEN_DEFAULT_AVATAR_ID env var serves as a platform-wide fallback for
-- users who haven't yet picked one (still required, just less personal).
--
-- Both columns are nullable: the column being NULL is the well-defined
-- "use the env fallback" state, not an error. The pipeline throws a
-- helpful AvatarNotConfiguredError if BOTH the column AND the env var
-- are unset.

alter table public.user_settings
  add column if not exists default_heygen_avatar_id text,
  add column if not exists default_heygen_voice_id  text;
