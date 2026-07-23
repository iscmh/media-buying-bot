import { Inngest } from 'inngest';

/**
 * Single Inngest client. Served from apps/web at /api/inngest (Vercel) and
 * also from apps/bot at /inngest (Railway) so jobs can run on either.
 */
export const inngest = new Inngest({
  id: 'media-buying-bot',
  // eventKey: process.env.INNGEST_EVENT_KEY,  // picked up automatically
});

/** Strongly-typed event names. Add new events here, then `inngest.send({...})`. */
export type Events = {
  'meta/launch.requested': {
    data: {
      userId: string;
      generationJobId: string;
      // Phase 4b additions — caller's choice; the worker still
      // honors BOT_DRY_RUN as the kill switch. Older callers that
      // omit these get full backwards-compat ('mock' default).
      mode?: 'mock' | 'live';
      pageId?: string;
      offerUrl?: string;
      targetingCountries?: string[];
      ageMin?: number;
      ageMax?: number;
      perAdBudgetUsd?: number;
    };
  };
  'performance/poll.scheduled': {
    data: { userId: string; adSetId: string; hourMark: number };
  };
  /** Phase 5: cron-triggered full poll across active launched_ads. */
  'performance/poll.tick': { data: Record<string, never> };
  /**
   * Phase 5: the bot callback handler dispatches this when the user
   * taps Confirm / Skip on a Telegram inline-keyboard prompt. The job
   * loads the pending_approvals row, validates ownership, executes
   * the Meta pause/scale (live or mock), and stamps the launched_ads
   * confirmed_at + counter.
   */
  'approval/decision.received': {
    data: { approvalId: string; decision: 'confirm' | 'skip' };
  };
  'kill_scale/evaluate.requested': {
    data: { userId: string; adId: string };
  };
  'generation/job.requested': {
    data: { userId: string; generationJobId: string };
  };
  // Phase 3a: split job pipeline. Static jobs go straight to
  // generation/static.requested; UGC jobs first hit analyze (Gemini Vision
  // deconstruction in 3b; mock JSON in 3a) then fan out to ugc.requested.
  'generation/analyze.requested': {
    data: { userId: string; jobId: string; mode: 'mock' | 'live' };
  };
  'generation/static.requested': {
    data: { userId: string; jobId: string; mode: 'mock' | 'live' };
  };
  'generation/ugc.requested': {
    data: { userId: string; jobId: string; mode: 'mock' | 'live' };
  };
  // Polish-20: unified video-variant worker — reads model_id +
  // provider_id from job.metadata and dispatches through the
  // descriptor-driven kie-video client (Seedance 1.5 Pro / Kling 3.0
  // Standard / Seedance 2 at launch).
  'generation/video-variant.requested': {
    data: { userId: string; jobId: string; mode: 'mock' | 'live' };
  };
  // Polish-6: Sora 2 single-shot pipeline.
  'generation/sora.requested': {
    data: { userId: string; jobId: string; mode: 'mock' | 'live' };
  };
  // Polish-6: Nano Banana static image pipeline.
  'generation/nano-banana.requested': {
    data: { userId: string; jobId: string; mode: 'mock' | 'live' };
  };
  // Polish-23 Commit 3: Higgsfield Soul + kie.ai Veo 3.1 Lite worker.
  'generation/polish23-veo-lite.requested': {
    data: { userId: string; jobId: string; mode: 'mock' | 'live' };
  };
  // Polish-25 Commit 2: MakeUGC pre-cast avatar UGC ad worker.
  'generation/polish25-makeugc.requested': {
    data: { userId: string; jobId: string; mode: 'mock' | 'live' };
  };
  // Polish-25.3 Commit 18b: OpenAI gpt-image-2 static ad worker.
  'generation/static-openai.requested': {
    data: { userId: string; jobId: string; mode: 'mock' | 'live' };
  };
  // Polish-25 Commit 7: on-demand trigger for the enriched avatar
  // index refresh. Nightly cron does the same work with empty
  // event.data — the manual path here lets the operator force an
  // immediate cycle without waiting for 3am UTC. `forceAll` re-
  // analyzes every row (not just new + >7d stale), useful after a
  // vision-prompt update.
  'makeugc/avatar-index.refresh.requested': {
    data: { userId?: string; forceAll?: boolean };
  };
  'summary/daily.requested': {
    data: { userId: string; date: string };
  };
  'telegram/notify.requested': {
    data: {
      userId: string;
      message: string;
      requiresApproval?: boolean;
      /**
       * Phase 5: inline-keyboard buttons. Each row is an array of
       * { text, callback_data } pairs. callback_data is what the bot
       * receives in callback_query — typically `approve:<approvalId>:<decision>`.
       */
      inlineButtons?: Array<Array<{ text: string; callbackData: string }>>;
    };
  };
  'token/expiry_check.scheduled': { data: Record<string, never> };
  'suspicious_activity/check.scheduled': { data: { userId: string } };
};
