-- Polish-23 Commit 3.0.6: one-shot zombie cleanup.
--
-- Marks every Polish-23 job that's stuck at status='processing' as
-- 'failed' with a clear reason. Every one of these rows is a
-- forensics-null casualty of Commits 3.0.1–3.0.4, where a Step-C
-- submit failure threw uncaught and the function ended before
-- markJobFailed could fire.
--
-- Commit 3.0.5 fixed the underlying pattern (persist forensics
-- BEFORE submit + try/catch around veo-clip step calls
-- markJobFailed on any failure). Commit 3.0.6 wraps the terminal
-- errors in NonRetriableError so retries don't burn credits.
-- Combined, no NEW zombies are possible from here forward — this
-- script only cleans the historical rows.
--
-- Run this MANUALLY via the Supabase SQL editor (Dashboard →
-- Project → SQL Editor). NOT wired into supabase/migrations/
-- because it's a one-off data cleanup and a genuinely-in-flight
-- Polish-23 job (rare — the failure mode requires the pre-3.0.5
-- worker) would get force-failed by an automatic migration run.
--
-- Idempotent: subsequent runs update zero rows once the initial
-- sweep completes (WHERE status='processing' fails to match).
--
-- Usage:
--   1. Open Supabase Studio → SQL Editor
--   2. Paste this file
--   3. Verify the SELECT preview count first
--   4. Run the UPDATE

-- Preview: how many rows will the sweep touch?
SELECT COUNT(*) AS zombie_polish23_jobs
FROM generation_jobs
WHERE status = 'processing'
  AND picked_pipeline = 'polish23_higgsfield_veo_lite';

-- Sweep. Uncomment when you're ready to fire.
-- UPDATE generation_jobs
-- SET
--   status = 'failed',
--   error_message = 'Polish-23 Commit 3.0.6 zombie cleanup: forensics-null Step-C submit failure from the pre-3.0.5 hotfix cycle. See git log for details.',
--   completed_at = NOW()
-- WHERE status = 'processing'
--   AND picked_pipeline = 'polish23_higgsfield_veo_lite';
