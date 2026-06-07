import { serve } from 'inngest/next';
import { functions, inngest } from '@mbb/jobs';

/**
 * Inngest webhook endpoint. Inngest cloud calls this URL to invoke our
 * registered functions. Configure the URL in the Inngest dashboard under
 * App Settings → Sync new app → use https://YOUR-DOMAIN/api/inngest
 */

// Polish-5: Vercel's 10s hobby / 15s pro default isn't enough for ad
// launches or batched polls.
//
// Polish-9.6: bumped from 60s to 300s (Vercel Pro per-request ceiling
// for serverless functions). Inngest invokes this route once per
// step.run; the Kling production-manual step alone can run 30-90s
// (Claude writing 16 clip prompts at maxTokens=16384), and a long
// concurrent Nano Banana batch can add more before the step returns.
// 300s gives plenty of headroom without forcing a switch to Inngest's
// connect mode. dynamic forces per-request execution so Next never
// tries to cache the Inngest webhook.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export const { GET, POST, PUT } = serve({ client: inngest, functions });
