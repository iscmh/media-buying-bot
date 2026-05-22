import { serve } from 'inngest/next';
import { functions, inngest } from '@mbb/jobs';

/**
 * Inngest webhook endpoint. Inngest cloud calls this URL to invoke our
 * registered functions. Configure the URL in the Inngest dashboard under
 * App Settings → Sync new app → use https://YOUR-DOMAIN/api/inngest
 */

// Polish-5: Vercel's 10s hobby/15s pro default isn't enough for ad
// launches or batched polls — those chain multiple Meta calls and can
// blow past it. 60s is the Vercel Pro per-function ceiling. dynamic
// forces per-request execution so Next never tries to cache the
// Inngest webhook.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export const { GET, POST, PUT } = serve({ client: inngest, functions });
