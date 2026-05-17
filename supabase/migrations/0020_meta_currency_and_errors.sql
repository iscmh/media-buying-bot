-- Polish-3.5: Meta currency handling + raw-error capture.
--
-- meta_connections gains:
--   account_currency           ISO code (USD / RON / EUR / ...). NULL on
--                              legacy rows; populated by the OAuth flow
--                              from /act_<id>?fields=currency.
--   account_timezone           IANA tz name from /act_<id>?fields=
--                              timezone_name. Display-only for now.
--   min_daily_budget_minor     Per-account override for Meta's documented
--                              minimum daily budget, in minor units of
--                              account_currency. NULL → fall back to the
--                              hardcoded per-currency default in
--                              @mbb/shared/currency.
--   pages                      jsonb array of {id, name, accessToken,
--                              tasks} from /me/accounts at connect time.
--                              Used at launch to (a) validate the
--                              user-picked page id and (b) pull the page
--                              access token without re-hitting Meta.
--
-- launched_ads gains:
--   meta_response_raw          jsonb of the full Meta API response on the
--                              creating call (success OR failure). Lets
--                              the UI surface the actual error_user_msg /
--                              error_subcode instead of the generic
--                              "Invalid parameter" rollup we were storing.
--
-- All additive + nullable: no downtime, no backfill required.

alter table public.meta_connections
  add column if not exists account_currency      text,
  add column if not exists account_timezone      text,
  add column if not exists min_daily_budget_minor integer,
  add column if not exists pages                 jsonb;

alter table public.launched_ads
  add column if not exists meta_response_raw     jsonb;
