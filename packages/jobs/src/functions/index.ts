import { dailySummaryGenerator } from './daily-summary-generator.js';
import { generationJobProcessor } from './generation-job-processor.js';
import { killScaleEvaluator } from './kill-scale-evaluator.js';
import { metaAdLauncher } from './meta-ad-launcher.js';
import { performancePoller } from './performance-poller.js';
import { suspiciousActivityMonitor } from './suspicious-activity-monitor.js';
import { telegramNotifier } from './telegram-notifier.js';
import { tokenExpiryChecker } from './token-expiry-checker.js';

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
