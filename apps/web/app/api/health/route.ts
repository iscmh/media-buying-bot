export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    ok: true,
    service: 'web',
    dryRun: (process.env.BOT_DRY_RUN ?? 'true').toLowerCase() === 'true',
    timestamp: new Date().toISOString(),
  });
}
