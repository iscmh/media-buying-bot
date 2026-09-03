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
 * Polish-27.0.0 (MAJOR bump from 26.0.14) marks the legacy UGC
 * surface nuke — HeyGen / Hedra / WaveSpeed / Replicate / Kie /
 * MakeUGC / ElevenLabs UGC pipelines all rejected on quality;
 * deck cleared for the Polish-28 Seedance 2.5 + Higgsfield Speak v2
 * + ElevenLabs BYOK rebuild.
 */
export const POLISH_VERSION = '29.0.46';

/**
 * Short human-readable slug that pairs with the version for at-a-
 * glance context in the /api/health response. Update alongside
 * POLISH_VERSION when the release ships a materially different fix
 * pattern. Kept intentionally terse post-Polish-27 — the sprawling
 * release notes made this string unreadable and a single stray
 * apostrophe could break the module load; ship-day narratives
 * belong in commit messages, not runtime constants.
 */
export const POLISH_RELEASE_NAME =
  'Polish-29.0.46 Commit 155 - strip `account` from every /google-flow/* submit body. After the still worked (145+150+151+153+154), the Omni seed clip submit blew up with the exact same `Parameter account not supported` error we saw on images. My earlier assumption (Commit 150) that /google-flow/videos differed from /google-flow/images was wrong - the WHOLE /google-flow/* namespace on useapi.net infers account from the API token, not the body. Fix: dropped `account` from submitOmniVideo, submitGoogleFlowConcat, and submitVeoVideo (Veo has no live caller yet, defensive parity so it does not fail the same way when someone wires it). The `account` field stays on every input type as an optional audit-log breadcrumb so worker call sites do not have to change. Dreamina submits are unchanged - they DO need account because useapi routes different Dreamina accounts to different upstream Bytedance queues. Commit 154 blurb preserved below.\n\nPolish-29.0.45 Commit 154 - Nano Banana still-poll shape mismatch. After the URL-encoding fix (Commit 153) the poll succeeded but extractMediaGenerationId returned undefined because the response body shape from /google-flow/images poll drifted from the documented Omni video shape (media[N].image.generatedImage.mediaGenerationId). Fixes: (a) added a bounded deep-walk fallback that finds mediaGenerationId at ANY depth in the response tree, (b) added console.log dumping top-level keys + media[0] keys + 800-char raw snippet when extraction fails so we can pattern-match the real shape from Vercel logs, (c) widened the polish30 still-poll handoff to fall back to imageUrl when no mediaGenerationId - submitOmniVideo startFrame accepts either an assetId (cheaper - no re-download) or a raw URL (Omni fetches once, still works). Pipeline continues past the still step as soon as we have EITHER form of reference. Commit 153 blurb preserved below.\n\nPolish-29.0.44 Commit 153 - actual root-cause fix: stop URL-encoding google-flow jobids. Commit 152 guessed wrong that image jobs poll at /google-flow/images/{jobid} - useapi returned "Wrong GET url" for that path (it is submit-only). Real cause: google-flow jobids look like j0903180709650836584i-u3061-email:isaacisverygoatedtho@gmail.com-bot:google-flow and useapi ROUTER wants the `:` / `@` chars RAW, not %3A / %40. Same as Dreamina (Commit 130). Fix: added google-flow to the no-encode branch in checkUseapiJob; reverted the image-vs-video path split from Commit 152 - both go to /google-flow/jobs/{jobid}. Now every google-flow job (Nano Banana still, Omni seed, V2V extends, concat) polls the same URL, just unencoded. Commit 152 blurb preserved below.\n\nPolish-29.0.43 Commit 152 - third and hopefully final /google-flow/images fix. After 150 (drop account) and 151 (drop n + aspectRatio) the submit finally succeeded. Then the still poll blew up with `Invalid job ID format` (HTTP 400) because google-flow splits its poll surface by resource kind: video jobs (Omni + Veo) poll at /google-flow/jobs/{jobid} but image jobs (Nano Banana 2 Lite/2/Pro) poll at /google-flow/images/{jobid}. Hitting /jobs/ with an image jobid trips the video routers id parser. Fix: added resourceKind: video | image field to CheckJobInput and the shared pollUntilComplete helper in polish30 so the still poll routes to /google-flow/images/{jobid} while every seed clip + V2V extend + concat poll stays on /jobs/. Default video means no other caller needed a change. This is the third same-endpoint fix in a row - once the Omni seed clip actually submits we get to see whether the shared UGC prose builder from Commit 149 lands the pacing right. Commit 151 blurb preserved below.\n\nPolish-29.0.42 Commit 151 - second hotfix on the same /google-flow/images call. After dropping account (Commit 150), useapi.net now returned `Parameter n not supported`. Nano Banana returns exactly one image per call by design (n=1 is implicit) and derives aspect ratio from the prose prompt itself, not a schema field. composeSeedStillPrompt already opens with "A single 9:16 vertical portrait photo of ..." which is what Nano Banana actually reads. Fix: strip both n and aspectRatio from the request body; keep the supported body to essentially just `{prompt, model}` plus optional `images` for reference-based edits. Retained the values on the request log for diagnostic parity. If a THIRD field is now flagged (unlikely - we are down to just prompt + model), same one-line fix pattern applies. Commit 150 blurb preserved below.\n\nPolish-29.0.41 Commit 150 - hotfix polish30 Nano Banana still submit. useapi.net rejected the very first step of every polish30 variation with `Parameter account not supported` (HTTP 400). Root cause: /google-flow/images is a stateless Gemini call under the hood (Nano Banana IS Gemini 2.5 Flash Image, 0 credits on every Google AI plan) - the API token identifies the billed org, no per-account routing. /google-flow/videos on the other hand does need account because Omni + Veo bill against a specific Google AI subscription tier. My Commit 145 client wrongly copy-pasted the videos body shape onto the images call. Fix: drop account from the /google-flow/images request body. Kept the account param on SubmitNanoBananaImageInput (now optional) so the polish30 worker call site does not need to change - the field just gets hashed for the audit log instead of sent to useapi. Video submits (Omni seed clip + V2V extend chain) unchanged; those still send account correctly. This unblocks Commit 149 (seedance25-ugc-yapper skill playbook port), which never actually ran end-to-end because the still submit died first.';

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
