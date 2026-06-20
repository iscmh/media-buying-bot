-- Polish-16 Fix 2: add 'failed' to creative_status enum so the kie-omni
-- worker can write per-segment + composite rows with status='failed'
-- on the failure path. Currently the worker only writes rows on the
-- success path, leaving failed jobs as a black box for post-mortem
-- queries.
--
-- This is a non-breaking ALTER TYPE — pgEnum ADD VALUE is online and
-- doesn't rewrite the column. Existing rows stay on their current
-- value. No backfill needed.
--
-- Idempotent.

do $$
begin
  alter type public.creative_status add value if not exists 'failed';
exception when duplicate_object then null;
end $$;
