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
  'summary/daily.requested': {
    data: { userId: string; date: string };
  };
  'telegram/notify.requested': {
    data: { userId: string; message: string; requiresApproval?: boolean };
  };
  'token/expiry_check.scheduled': { data: Record<string, never> };
  'suspicious_activity/check.scheduled': { data: { userId: string } };
};
