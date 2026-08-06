/**
 * Polish-21.0.15: single source of truth for the shipped Polish
 * version. Imported by:
 *
 *   - packages/jobs (worker → composite-row metadata + cold-start log)
 *   - apps/web `/api/health` (curl-verifiable freshness endpoint)
 *   - apps/web `/api/version` (dedicated version endpoint)
 *
 * A shared constant creates a cross-package import chain that MUST
 * rebuild every downstream when this file changes — no more "did
 * Vercel actually pick up the packages/jobs change?" guessing.
 *
 * ---------------------------------------------------------------
 * WHY THIS EXISTS — Polish-21.0.15 root-cause diagnostic
 * ---------------------------------------------------------------
 * Job 961281c5 showed `polish_version: null` on a failed RETRY
 * even though Vercel dashboard confirmed the Polish-21.0.14 SHA
 * (1065775) as deployed. Root cause was likely Inngest's
 * documented behavior: retries of an IN-FLIGHT job execute
 * against the function version that was live when the job was
 * FIRST invoked — not the currently-deployed version. So a job
 * originally submitted pre-Polish-21.0.14 keeps running the old
 * code on every retry.
 *
 * Diagnosis protocol for a "did the deploy stick?" report:
 *   1. Curl `/api/health` — reports POLISH_VERSION. If the value
 *      isn't the SHA-in-question, the deploy legitimately didn't
 *      stick (rare — check Vercel build logs).
 *   2. If /api/health shows the expected version but composite
 *      rows still say polish_version=null, submit a NEW job (not
 *      a retry). Inngest's frozen-version-per-job behavior means
 *      retries never see new code.
 *   3. To force an in-flight job onto the new code: cancel it in
 *      the Inngest dashboard and re-invoke — Inngest treats that
 *      as a new submission and picks up the current function
 *      version.
 */

/**
 * Bumped on every Polish release. Format: MAJOR.MINOR.PATCH.
 * Change here → next `pnpm build` cascades through @mbb/jobs +
 * apps/web (both `transpilePackages`-linked to @mbb/shared).
 *
 * Polish-25.1 (MINOR bump from 25.0.x) marks the UX-layer overhaul
 * shipping in Commit 10a + 10b. The pipeline / worker / BYOK
 * plumbing (Commits 1-9) is untouched; only the presentation +
 * information-architecture layer changes.
 */
export const POLISH_VERSION = '26.0.6';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-26.0.6 Commit 61.6 hotfix - polish26_heygen worker crashed on 'concept requires persona' because analyze-concept's usesPolish23Vision gate was never updated for polish26. Real evidence from operator SQL: concept ddca175b metadata.analysis has subject/audio_cues/visual_cues/script_transcription/video_duration_seconds/implied_device/social_context but MISSES persona/emotional_arc/hook_structure/niche_category/setting_details; analyzed 2026-08-06T07:16:01. Root cause: analyze-concept.ts line 199-200 usesPolish23Vision gate was 'picked === polish23_higgsfield_veo_lite || picked === polish25_makeugc' — Commit 61 added polish26_heygen worker + Commit 61.5 wired the user-facing form to dispatch it, but neither added polish26_heygen to the analyze-concept gate. Result: polish26 jobs ran analyze-concept under UGC_DECONSTRUCTOR_SYSTEM_PROMPT (subject-only shape) instead of POLISH23_VISION_SYSTEM_PROMPT (persona-rich shape). HeyGen worker's persona-required check then tripped 100%. Two-part fix. (a) Path B - analyze-concept.ts gate: added polish26_heygen to the OR list so FUTURE polish26 analyses get the structured persona schema. One-line change. (b) Path A - persona fallback synthesizer in @mbb/shared/persona-synthesizer.ts: parses subject.appearance + subject.performance + audio_cues.dialogue_quality + social_context freeform strings into a Polish23Persona-shaped record (gender via keyword hits + numeric-year regex; age_range via numeric-year → bucket + keyword fallback; ethnicity via keyword hits with latino→hispanic mapping since Polish23PersonaEthnicity enum has no latino slot; voice_tone via first-recognized-word match else raw string). Returns null when no gender signal — worker fails loud with 'run analyze-concept' rather than routing to a random avatar. HeyGen worker's load-concept-source-context step now tries structured persona first, falls back to synthesizer, only fails when both fail. Log-loud when synthesizer fires: '[polish-26-worker] concept X has no structured persona field — synthesized from subject.appearance/audio_cues.dialogue_quality'. Regression pin: persona-synthesizer.test.ts +8 assertions covering null/empty inputs, no-gender-signal (product-only appearance) returns null, operator's ddca175b shape → female/20s/white, middle-aged-male + numeric age → 40s, latino→hispanic enum mapping, elderly gentleman → 70s + calm voice tone, tie→female defense-in-depth, defaults for age_range=30s + ethnicity=other when unspecified. Do-not-touched: HeyGen client, sync worker, Meta launcher, static pipelines, MakeUGC worker (unaffected — polish25 was already in the analyze-concept gate). Version bump: POLISH_VERSION 26.0.5 -> 26.0.6.";

/**
 * Frozen at module-load time so cold-start diagnostics have a
 * stable value even if a caller mutates process.env mid-execution.
 * Consumed by /api/health for release-SHA reporting when the
 * platform sets VERCEL_GIT_COMMIT_SHA (Vercel does by default).
 */
export const POLISH_RELEASE_SHA: string =
  process.env['VERCEL_GIT_COMMIT_SHA'] ??
  process.env['GIT_COMMIT_SHA'] ??
  '(unknown — set VERCEL_GIT_COMMIT_SHA or GIT_COMMIT_SHA)';
