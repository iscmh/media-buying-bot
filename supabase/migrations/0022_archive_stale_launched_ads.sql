-- Polish-5 (part 1 of 2): extend launched_ad_status with 'archived'.
--
-- Postgres won't allow a new enum value to be USED in the same
-- transaction that adds it. The bulk UPDATE that consumes 'archived'
-- lives in migration 0023, ensuring this ALTER commits first.
--
-- Idempotent: ADD VALUE IF NOT EXISTS makes re-running this migration
-- a no-op. The DO block swallows the duplicate_object exception for
-- defensive symmetry with earlier enum extensions in this repo.

do $$
begin
  alter type public.launched_ad_status add value if not exists 'archived';
exception when duplicate_object then null;
end $$;
