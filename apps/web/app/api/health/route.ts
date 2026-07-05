import { POLISH_RELEASE_NAME, POLISH_RELEASE_SHA, POLISH_VERSION } from '@mbb/shared';

export const dynamic = 'force-dynamic';

/**
 * Polish-21.0.15 hotfix: /api/health reports the shipped Polish
 * version so operators can curl-verify deploy freshness in <1
 * second — no more waiting for a job to run + SQL-inspecting the
 * composite row to prove which code is live. Root-cause context in
 * packages/shared/src/polish-version.ts.
 *
 * Example:
 *   $ curl https://<host>/api/health | jq .polish_version
 *   "21.0.15"
 */
export async function GET() {
  return Response.json({
    ok: true,
    service: 'web',
    dryRun: (process.env.BOT_DRY_RUN ?? 'true').toLowerCase() === 'true',
    timestamp: new Date().toISOString(),
    // Polish-21.0.15: single source of truth from @mbb/shared.
    // Bumping the constant forces a Next transpile of every
    // workspace package that imports it, cascading through
    // @mbb/jobs into the Inngest route bundle.
    polish_version: POLISH_VERSION,
    polish_release_name: POLISH_RELEASE_NAME,
    polish_release_sha: POLISH_RELEASE_SHA,
    node_version: process.version,
  });
}
