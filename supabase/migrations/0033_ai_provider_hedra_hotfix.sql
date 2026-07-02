-- Polish-21 Commit 2 hotfix: insurance re-apply of the 'hedra'
-- ai_provider enum value. Migration 0032 asserts the same value with
-- `if not exists`, so both migrations are safe to run against any
-- state — this file exists because the operator reported an enum-name
-- confusion during Polish-21 Commit 1 rollout and manually applied
-- ALTER TYPE in prod. Fresh deploys pick the value up via 0032; this
-- follow-up is a no-op there. Any deploy path lacking the value gets
-- it now.
--
-- Do NOT drop or rename 0032 — the operator's prod state is aligned
-- with 0032's intent and Supabase migration ordering must stay
-- append-only. This file is strictly additive insurance.

do $$
begin
  alter type public.ai_provider add value if not exists 'hedra';
exception when duplicate_object then null;
end $$;
