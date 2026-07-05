import { POLISH_RELEASE_NAME, POLISH_RELEASE_SHA, POLISH_VERSION } from '@mbb/shared';

export const dynamic = 'force-dynamic';

/**
 * Polish-21.0.15: dedicated, machine-friendly `/api/version`
 * endpoint. Same source data as `/api/health` but with a smaller
 * response shape — safer for monitoring / cron / CI probes that
 * want a stable schema.
 *
 * The route returns 200 with the version and a plain-text
 * `x-polish-version` header so operators / probes can inspect
 * either the body or the header without parsing JSON.
 *
 * Example:
 *   $ curl -sI https://<host>/api/version | grep -i polish
 *   x-polish-version: 21.0.15
 *
 *   $ curl -s https://<host>/api/version
 *   {"polish_version":"21.0.15","polish_release_sha":"…"}
 */
export async function GET() {
  return Response.json(
    {
      polish_version: POLISH_VERSION,
      polish_release_name: POLISH_RELEASE_NAME,
      polish_release_sha: POLISH_RELEASE_SHA,
    },
    {
      headers: {
        'x-polish-version': POLISH_VERSION,
        'cache-control': 'no-store, no-cache, must-revalidate',
      },
    },
  );
}
