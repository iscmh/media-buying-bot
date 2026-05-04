import { dailySummaryGenerator } from './daily-summary-generator';
import { generationJobProcessor } from './generation-job-processor';
import { killScaleEvaluator } from './kill-scale-evaluator';
import { metaAdLauncher } from './meta-ad-launcher';
import { performancePoller } from './performance-poller';
import { suspiciousActivityMonitor } from './suspicious-activity-monitor';
import { telegramNotifier } from './telegram-notifier';
import { tokenExpiryChecker } from './token-expiry-checker';

export const functions = [
  metaAdLauncher,
  performancePoller,
  killScaleEvaluator,
  generationJobProcessor,
  dailySummaryGenerator,
  telegramNotifier,
  tokenExpiryChecker,
  suspiciousActivityMonitor,
];
