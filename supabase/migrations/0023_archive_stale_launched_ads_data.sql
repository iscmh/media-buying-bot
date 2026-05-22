-- Polish-5 (part 2 of 2): backfill the 'archived' status on stale rows.
--
-- Two patterns of dead weight after the 24h prod test:
--   1. Rows that never got a meta_ad_id (launch_failed early, before
--      Phase 4b error handling tightened up). They'll never produce
--      insights, never need polling.
--   2. Rows older than 14 days that haven't been polled in the last
--      24h — these are ads the user paused/killed in Ads Manager
--      directly and Meta no longer returns insights for, so the poll
--      stops touching them.
--
-- "no performance_logs in last 24h" from the spec maps to last_polled_at
-- on launched_ads — performance_logs.ad_id references concept-level
-- ads (Phase-1 table), not launched_ads. last_polled_at is the
-- canonical "last time we tried to fetch insights for this row" signal.
--
-- Terminal statuses (killed / rejected_by_meta / launch_failed) stay
-- as-is — they already mean "stop polling" and their distinction
-- matters for the audit log.
--
-- The (status) index from migration 0021 already accelerates the
-- "show me archived rows" + "exclude archived from the poll" filters.

update public.launched_ads
   set status = 'archived'
 where status not in ('archived', 'killed', 'rejected_by_meta', 'launch_failed')
   and (
        meta_ad_id is null
     or (
            launched_at < now() - interval '14 days'
        and (last_polled_at is null or last_polled_at < now() - interval '24 hours')
        )
   );
