-- Polish-23 Commit 1: add 'wavespeed_ai' to the ai_provider enum so
-- operators can persist a BYOK WaveSpeedAI key in the
-- ai_provider_connections table.
--
-- WaveSpeedAI hosts the Higgsfield Soul image-to-image endpoint that
-- generates the reference character image for the new Polish-23
-- kie.ai Veo 3.1 Lite pipeline (Commit 3 will wire the worker). The
-- connect card lands in Polish-23 Commit 1 so operators can pre-
-- paste the key before Commit 3 ships the pipeline live.
--
-- Idempotent: `add value if not exists` per the Polish-6/8/21
-- migration convention. Mirrors 0032_ai_provider_hedra.sql shape.

do $$
begin
  alter type public.ai_provider add value if not exists 'wavespeed_ai';
exception when duplicate_object then null;
end $$;
