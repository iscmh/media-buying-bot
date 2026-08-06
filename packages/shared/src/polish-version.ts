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
export const POLISH_VERSION = '26.0.8';

/**
 * Optional short human-readable slug that pairs with the version
 * for at-a-glance context in the /api/health response. Update
 * alongside POLISH_VERSION when the release ships a materially
 * different fix pattern.
 */
export const POLISH_RELEASE_NAME =
  "Polish-26.0.8 Commit 61.8 hotfix - two-layer defense against Inngest UNDEFINED_VALUE in polish26-heygen worker. Real evidence: Inngest run 01KZBK8ZRY990R72PD4BW039JG failed with UNDEFINED_VALUE on load-job step; broader class of failures where Inngest's step-result serializer chokes on any object containing an undefined-valued key. Fix layers: (a) new packages/jobs/src/lib/strip-undefined.ts with shallow stripUndefined<T>(obj) helper - filters keys whose value is exactly `undefined`, keeps null/0/''/false/NaN which are all meaningful JSON. Deliberately shallow so nested objects and arrays pass through untouched (deep-strip would mangle typed structures). (b) patchMetadata() in generate-polish26-heygen.ts now runs the incoming patch through stripUndefined BEFORE spreading into existing metadata + writing to Drizzle - one boundary strip covers every metadata write in the worker so no per-call-site risk of forgetting. (c) polish26_avatar_match projection (both enriched-index + gender-only-fallback paths) explicitly `?? null` coerces every heygen_avatar_index-derived nullable column: winnerAgeBucket, winnerEthnicity, winnerHairColor, winnerHairStyle, winnerFacialHair, winnerWardrobeStyle, winnerWardrobeSummary, winnerBackground. Fields land as present-and-null in the metadata JSON, not omitted keys. (d) HeygenMatchStepReturn interface widened avatarName + voiceName to `string | null` so the `?? null` coercion has a landing spot in the type - avatarName is NOT NULL in the schema today but Drizzle's typed unions can drift, keeping the return null-durable means Inngest's step-result serializer never sees undefined. (e) Fallback path also adds winnerAvatarName + winnerAvatarGender to the metadata blob (both `?? null`d) for symmetry. Regression pin: packages/jobs/tests/strip-undefined.test.ts +7 assertions - drops undefined, keeps null / 0 / '' / false / NaN (all meaningful JSON), shallow (nested undefined pass through), empty input → {}, does not mutate input, handles the operator-reported polish26_avatar_match projection shape without dropping the null coercions. Do-not-touched: HeyGen client, sync worker, Meta launcher, static pipelines, MakeUGC worker. Version bump: POLISH_VERSION 26.0.7 -> 26.0.8.";

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
