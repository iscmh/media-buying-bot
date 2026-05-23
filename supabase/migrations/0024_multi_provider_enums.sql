-- Polish-4 (part 1 of 2): extend ai_provider + add provider_tier enums.
--
-- Two new ai_provider values: 'kling' (cinematic video gen via
-- Replicate), 'elevenlabs' (TTS voiceover for kling cinematic
-- variants). 'replicate' + 'tavus' reserved for future providers so
-- the enum is forward-compatible without another ALTER TYPE round.
--
-- provider_tier is new. nullable on ai_provider_connections — most
-- providers don't have a tiered API (Replicate, ElevenLabs). HeyGen
-- uses it to gate Premium avatars.
--
-- Postgres won't allow a new enum value to be USED in the same
-- transaction that adds it. The bulk UPDATE that consumes new values
-- lives in migration 0025; this file is enum extensions only.

do $$
begin
  alter type public.ai_provider add value if not exists 'kling';
exception when duplicate_object then null;
end $$;

do $$
begin
  alter type public.ai_provider add value if not exists 'replicate';
exception when duplicate_object then null;
end $$;

do $$
begin
  alter type public.ai_provider add value if not exists 'tavus';
exception when duplicate_object then null;
end $$;

do $$
begin
  alter type public.ai_provider add value if not exists 'elevenlabs';
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.provider_tier as enum ('free', 'pro', 'premium');
exception when duplicate_object then null;
end $$;
