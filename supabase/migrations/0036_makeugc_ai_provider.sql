-- Polish-25 Commit 1: add 'makeugc' to the ai_provider enum so
-- operators can persist a BYOK MakeUGC API Starter key in the
-- ai_provider_connections table.
--
-- MakeUGC (makeugc.com) is the pay-per-video UGC ad generator that
-- replaces the Polish-24 HeyGen pivot. Real economics: $99/mo API
-- Starter = 2,000 credits/mo = $0.0495/video (20-50x cheaper than
-- the alternatives evaluated). Auth via X-Api-Key header, avatars
-- + voices via GET /video/avatars + GET /video/voices, submit via
-- POST /video/generate, poll via GET /video/status. Polish-25
-- Commit 2 will wire the worker; Commit 1 lands the client + BYOK
-- so operators can pre-paste the key.
--
-- Idempotent: `add value if not exists` per the Polish-6/8/21/23
-- migration convention. Mirrors 0034_wavespeed_ai_provider.sql shape.

do $$
begin
  alter type public.ai_provider add value if not exists 'makeugc';
exception when duplicate_object then null;
end $$;
