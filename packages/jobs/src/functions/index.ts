import { analyzeConcept } from './analyze-concept';
import { dailySummaryGenerator } from './daily-summary-generator';
import { manualDailySummary } from './manual-daily-summary';
import { generateCinematicVariants } from './generate-cinematic-variants';
import { generateKlingMultiClipVariants } from './generate-kling-multi-clip-variants';
import { generateKling3OmniMultiSegment } from './generate-kling-3-omni-multi-segment';
import { generateKieOmniFlashNative } from './generate-kie-omni-flash-native';
import { generateKieKlingAvatarV2 } from './generate-kie-kling-avatar-v2';
import { generateVeo31Fast } from './generate-veo-3-1-fast';
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
  'generation/cinematic.requested',
  'generation/kling-multi-clip.requested',
  'generation/kling-3-omni-multi-segment.requested',
  'generation/kie-omni-flash-native.requested',
  'generation/kie-kling-avatar-v2.requested',
  'generation/veo-3-1-fast.requested',
  'generation/sora.requested',
  'generation/nano-banana.requested',
  'generation/static.requested',
] as const);

export const functions = [
  // Phase 3a: concept generation pipeline.
  analyzeConcept,
  generateStaticVariants,
  generateUgcVariants,
  // Polish-4: cinematic voiceover format (Kling 2.5 + ElevenLabs) — deprecated, kept as fallback.
  generateCinematicVariants,
  // Polish-6: new pipelines.
  generateKlingMultiClipVariants,
  generateSoraVariants,
  generateStaticImageVariants,
  // Polish-10: Kling 3.0 Omni multi-segment (default Kling pipeline).
  generateKling3OmniMultiSegment,
  // Polish-12: kie.ai Gemini Omni Flash native pipeline (opt-in).
  generateKieOmniFlashNative,
  // Polish-19: kie.ai Kling Avatar v2 pipeline (single-call lipsync — advanced).
  generateKieKlingAvatarV2,
  // Polish-19.2: Veo 3.1 Fast native-audio pipeline (new default).
  generateVeo31Fast,
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
