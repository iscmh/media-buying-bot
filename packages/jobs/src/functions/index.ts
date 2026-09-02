import { analyzeConcept } from './analyze-concept';
import { dailySummaryGenerator } from './daily-summary-generator';
import { manualDailySummary } from './manual-daily-summary';
import { generateVideoVariant } from './generate-video-variant';
import { generateSoraVariants } from './generate-sora-variants';
import { generateStaticImageVariants } from './generate-static-image-variants';
// Polish-27.0.0 Commit 63: legacy UGC workers UNREGISTERED for the
// Polish-28 rebuild. Import statements retained (commented) so the
// rollback is a one-line reversal. Worker files themselves are NOT
// deleted — code stays on disk, tests stay live, DB tables preserved.
// See POLISH_RELEASE_NAME for the rebuild rationale.
// import { generatePolish23VeoLite } from './generate-polish23-veo-lite';
// import { generatePolish25Makeugc } from './generate-polish25-makeugc';
// import { generatePolish26Heygen } from './generate-polish26-heygen';
// import {
//   refreshMakeugcAvatarIndexCron,
//   refreshMakeugcAvatarIndexManual,
// } from './refresh-makeugc-avatar-index';
// import {
//   refreshHeygenAvatarIndexCron,
//   refreshHeygenAvatarIndexManual,
// } from './refresh-heygen-avatar-index';
import { generateStaticOpenaiImageVariants } from './generate-static-openai-image-variants';
// Polish-28.0.0 Commit 64: BYOK cloned-UGC pipeline (Nano Banana Pro
// character clone + ElevenLabs Instant Voice Clone + HeyGen Avatar IV
// image-to-video lip-sync). Rebuild successor to the Polish-25/26 nuke.
import { generatePolish28CloneUgc } from './generate-polish28-clone-ugc';
import { generatePolish28VariationsUgc } from './generate-polish28-variations-ugc';
// Polish-29.0.6 Commit 115: Seedance credit-backed video generation
// via useapi.net → Dreamina. First credits-mode worker end-to-end;
// wraps the tested seedance-credit-flow helper.
import { generatePolish29Seedance } from './generate-polish29-seedance';
// Polish-29.0.10 Commit 119: credit-backed multi-clip Seedance
// VARIATIONS. Feed a winning creative → N cloned-character variants,
// each M × 8s Seedance clips concatenated to source-ad length. Uses
// Nano Banana Pro for character anchor + Claude batch for N distinct
// persona+script pairs + Replicate ffmpeg concat for the composite.
import { generatePolish29SeedanceVariations } from './generate-polish29-seedance-variations';
import { generateStaticVariants } from './generate-static-variants';
import { generateUgcVariants } from './generate-ugc-variants';
import { generationJobProcessor } from './generation-job-processor';
import { handleApprovalDecision } from './handle-approval-decision';
import { killScaleEvaluator } from './kill-scale-evaluator';
import { metaAdLauncher } from './meta-ad-launcher';
import { performancePoller } from './performance-poller';
import { pollAdPerformance } from './poll-ad-performance';
import { suspiciousActivityMonitor } from './suspicious-activity-monitor';
import { telegramNotifier } from './telegram-notifier';
import { tokenExpiryChecker } from './token-expiry-checker';
import { cleanupErrorLog } from './cleanup-error-log';
import { dailyTelegramSummary } from './daily-telegram-summary';
import { weeklyTelegramRollup } from './weekly-telegram-rollup';

/**
 * Polish-19.2.1: explicit registry of every Inngest worker-listener
 * event in the codebase. The set below is the source of truth — the
 * coverage test in tests/dispatch-coverage.test.ts asserts every
 * PipelineType in @mbb/shared's ALL_PIPELINES maps to one of these
 * via its descriptor.workerEvent.
 *
 * Why a hand-maintained set rather than runtime introspection:
 * Inngest's InngestFunction doesn't expose its trigger config as a
 * public field, so we'd have to scrape the source files. A
 * hand-maintained set + a coverage test is more reliable and
 * surfaces a missing-worker drift in CI before deploy.
 *
 * When adding a new generation worker: register its event below AND
 * the inngest.createFunction listener config inside the worker file.
 * The CI test catches mismatches.
 */
// Polish-27.0.0 Commit 63: legacy UGC events UNREGISTERED.
// Removed from this set: polish23-veo-lite.requested,
// polish25-makeugc.requested, polish26-heygen.requested. Corresponding
// worker files preserved on disk (see commented imports above);
// pipeline descriptors preserved so PipelineType stays complete for
// downstream forensics + the coverage test's ALL_PIPELINES has been
// narrowed to only-registered set in pipeline-descriptors.ts. Rollback
// = uncomment the imports + function[] entries + descriptor entries.
export const REGISTERED_GENERATION_WORKER_EVENTS = new Set([
  'generation/ugc.requested',
  'generation/sora.requested',
  'generation/nano-banana.requested',
  'generation/static.requested',
  // Polish-20: unified video-variant worker (Seedance 1.5 Pro /
  // Kling 3.0 Standard / Seedance 2 / etc.). Reads model_id +
  // provider_id from job.metadata and dispatches through the
  // descriptor-driven kie-video client.
  'generation/video-variant.requested',
  // Polish-25.3 Commit 18b: OpenAI gpt-image-2 static ad pipeline —
  // the SOLE surviving user-facing generation pipeline post-Polish-27
  // Commit 63 nuke. Static ads keep working end-to-end.
  'generation/static-openai.requested',
  // Polish-28.0.0 Commit 64: BYOK cloned-UGC pipeline. First re-add
  // to the registered set since the Polish-27 Commit 63 clear-out.
  'generation/polish28-clone-ugc.requested',
  // Polish-28.3.0 Commit 85: variations pipeline. Descriptor added
  // in Commit 85 but never surfaced here — dispatch-coverage caught
  // it on the Polish-29.0.6 rerun. Fixing forward.
  'generation/polish28-variations-ugc.requested',
  // Polish-29.0.6 Commit 115: credit-backed Seedance via useapi.net.
  // Marks the switch from BYOK-only (Polish-28) to a hybrid where
  // credit-costed models run through the shared reserve/consume/
  // release flow.
  'generation/polish29-seedance.requested',
  // Polish-29.0.10 Commit 119: credit-backed multi-clip Seedance
  // variations. Feed a winning creative → N cloned-character variants
  // matching the source ad's length. The video render itself pays in
  // credits; Claude + Gemini + Replicate BYOK cover the char ref,
  // persona+script batch, and clip concat.
  'generation/polish29-seedance-variations.requested',
] as const);

export const functions = [
  // Phase 3a: concept generation pipeline.
  analyzeConcept,
  generateStaticVariants,
  generateUgcVariants,
  // Polish-6: legacy Sora + Nano Banana pipelines (kept for the
  // non-UGC-video paths that survived the Polish-20 legacy purge).
  generateSoraVariants,
  generateStaticImageVariants,
  // Polish-20: unified descriptor-driven video-variant worker
  // (Seedance 1.5 Pro / Kling 3.0 Standard / Seedance 2).
  generateVideoVariant,
  // Polish-27.0.0 Commit 63: legacy UGC workers UNREGISTERED for
  // the Polish-28 rebuild. Removed from the dispatch array:
  //   - generatePolish23VeoLite
  //   - generatePolish25Makeugc
  //   - generatePolish26Heygen
  //   - refreshMakeugcAvatarIndexCron + refreshMakeugcAvatarIndexManual
  //   - refreshHeygenAvatarIndexCron + refreshHeygenAvatarIndexManual
  // Worker files preserved on disk; rollback = uncomment the
  // imports at the top of the file + re-add these entries here.
  // Polish-25.3 Commit 18b: OpenAI gpt-image-2 static ad worker.
  generateStaticOpenaiImageVariants,
  // Polish-28.0.0 Commit 64: BYOK cloned-UGC pipeline worker.
  generatePolish28CloneUgc,
  generatePolish28VariationsUgc,
  // Polish-29.0.6 Commit 115: credit-backed Seedance worker.
  generatePolish29Seedance,
  // Polish-29.0.10 Commit 119: multi-clip Seedance variations worker.
  generatePolish29SeedanceVariations,
  // Phase 4 launch.
  metaAdLauncher,
  // Phase 5 — kill / scale loop.
  pollAdPerformance,
  handleApprovalDecision,
  // Phase 1+2 stubs / shared helpers.
  performancePoller,
  killScaleEvaluator,
  generationJobProcessor,
  dailySummaryGenerator,
  // Polish-7.1: manual trigger for /admin/test-actions.
  manualDailySummary,
  telegramNotifier,
  tokenExpiryChecker,
  suspiciousActivityMonitor,
  // Polish-25.7 Commit 46: nightly 90d retention sweep on error_log.
  cleanupErrorLog,
  // Polish-25.8 Commit 48: Telegram daily / weekly summary crons.
  dailyTelegramSummary,
  weeklyTelegramRollup,
];
