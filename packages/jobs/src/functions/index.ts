import { analyzeConcept } from './analyze-concept';
import { dailySummaryGenerator } from './daily-summary-generator';
import { manualDailySummary } from './manual-daily-summary';
import { generateCinematicVariants } from './generate-cinematic-variants';
import { generateKlingMultiClipVariants } from './generate-kling-multi-clip-variants';
import { generateKling3OmniMultiSegment } from './generate-kling-3-omni-multi-segment';
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
