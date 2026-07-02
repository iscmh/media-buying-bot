-- Polish-21: add 'hedra' to the ai_provider enum. Hedra Character 3
-- image-to-talking-avatar replaces the Polish-20 kie.ai 3-model text-
-- to-video pipeline. BYOK key stored in ai_provider_connections under
-- provider='hedra'. Standalone migration (no dependent bulk UPDATE)
-- so it can ship without a follow-up migration file.

do $$
begin
  alter type public.ai_provider add value if not exists 'hedra';
exception when duplicate_object then null;
end $$;
