-- Polish-3 hotfix: ensure applications.whop_product_id exists.
--
-- Migration 0016 declared this column inline with the rest of the
-- applications table, but at least one deployed DB ended up without it
-- (cause unconfirmed — possible partial apply). The /admin/applications
-- query reads every column via Drizzle's findMany, which surfaces as a
-- PostgresError on page load.
--
-- IF NOT EXISTS makes the ALTER idempotent — no-op on a DB that already
-- has the column from 0016, additive on the one that doesn't.

alter table public.applications
  add column if not exists whop_product_id text;
