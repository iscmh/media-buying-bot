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
    data: { userId: string; generationJobId: string };
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
  'summary/daily.requested': {
    data: { userId: string; date: string };
  };
  'telegram/notify.requested': {
    data: { userId: string; message: string; requiresApproval?: boolean };
  };
  'token/expiry_check.scheduled': { data: Record<string, never> };
  'suspicious_activity/check.scheduled': { data: { userId: string } };
};
