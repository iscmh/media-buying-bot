import { serve } from 'inngest/next';
import { functions, inngest } from '@mbb/jobs';

/**
 * Inngest webhook endpoint. Inngest cloud calls this URL to invoke our
 * registered functions. Configure the URL in the Inngest dashboard under
 * App Settings → Sync new app → use https://YOUR-DOMAIN/api/inngest
 */
export const { GET, POST, PUT } = serve({ client: inngest, functions });
