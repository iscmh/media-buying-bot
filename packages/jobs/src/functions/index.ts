import { analyzeConcept } from './analyze-concept';
import { dailySummaryGenerator } from './daily-summary-generator';
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
  telegramNotifier,
  tokenExpiryChecker,
  suspiciousActivityMonitor,
];
