import { inngest } from '../client';

/**
 * Evaluates user's kill rules + scale tiers against the latest performance
 * snapshot. Issues kill commands to Meta or scales budget. Triggers a
 * Telegram approval request when scaling beyond manualApprovalThreshold.
 *
 * Anti-ban: respects "don't kill more than 50% of ad sets in an hour".
 *
 * Phase 5.
 */
export const killScaleEvaluator = inngest.createFunction(
  { id: 'kill-scale-evaluator', name: 'Kill / scale evaluator' },
  { event: 'kill_scale/evaluate.requested' },
  async ({ event, step }) => {
    void event;
    void step;
    throw new Error('killScaleEvaluator not implemented (Phase 5)');
  },
);
