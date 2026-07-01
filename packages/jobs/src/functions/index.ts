import { analyzeConcept } from './analyze-concept';
import { dailySummaryGenerator } from './daily-summary-generator';
import { manualDailySummary } from './manual-daily-summary';
import { generateVideoVariant } from './generate-video-variant';
import { generateSoraVariants } from './generate-sora-variants';
import { generateStaticImageVariants } from './generate-static-image-variants';
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
];
