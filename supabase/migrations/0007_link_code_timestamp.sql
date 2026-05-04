-- Per-code expiry tracking on telegram_connections.
--
-- The row's `created_at` reflects when the row was first inserted, which
-- doesn't match "when this code was generated" once a user re-enters the
-- Telegram link step (we overwrite link_code on the existing row). Adding
-- a dedicated `link_code_generated_at` column gives us a clean expiry check
-- (15 minutes) regardless of how old the row is.
--
-- Column is nullable: rows without an active code (already linked, or never
-- generated one) leave it NULL. Code generation sets it to now(); successful
-- redemption clears link_code AND link_code_generated_at to NULL.

alter table public.telegram_connections
  add column if not exists link_code_generated_at timestamptz;

-- Backfill: any existing rows with a non-null link_code get the row's
-- created_at as a best-effort generation time. Brand-new install has zero
-- such rows, so this is a no-op in practice.
update public.telegram_connections
set    link_code_generated_at = created_at
where  link_code is not null
  and  link_code_generated_at is null;

-- Index for the redemption lookup hot path: bot's /start <code> handler
-- queries WHERE link_code = $1 AND status = 'pending'. Already partial-indexed
-- via the unique constraint on link_code; nothing extra needed here.
