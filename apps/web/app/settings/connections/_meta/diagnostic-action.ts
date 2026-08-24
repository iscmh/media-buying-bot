'use server';

/**
 * Polish-28.4.2 Commit 100: server action wrapper for the Meta ad-
 * account diagnostic. Loads the stored token, decrypts, calls the
 * diagnostic per attached ad account, returns results.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { decryptSecret, getDb, logAuditEvent, schema } from '@mbb/db';
import { diagnoseAdAccount, type AdAccountDiagnostic } from '@mbb/meta-api';
import { getSupabaseServerClient } from '@/lib/supabase/server';

async function requireUser() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  return user;
}

export interface RunMetaDiagnosticResult {
  ok: boolean;
  errorMessage?: string;
  diagnostics?: AdAccountDiagnostic[];
}

export async function runMetaDiagnosticAction(): Promise<RunMetaDiagnosticResult> {
  const user = await requireUser();
  const db = getDb();

  const conn = await db.query.metaConnections.findFirst({
    where: and(
      eq(schema.metaConnections.userId, user.id),
      isNull(schema.metaConnections.deletedAt),
    ),
    columns: { accessTokenEncrypted: true, adAccountIds: true, status: true },
  });

  if (!conn) {
    return { ok: false, errorMessage: 'No Meta connection on file. Connect Meta first.' };
  }
  if (!conn.accessTokenEncrypted) {
    return { ok: false, errorMessage: 'Meta access token not stored. Reconnect Meta.' };
  }
  const adAccountIds = conn.adAccountIds ?? [];
  if (adAccountIds.length === 0) {
    return {
      ok: false,
      errorMessage:
        'No ad accounts selected on your Meta connection. Pick at least one in the selection form above, then re-run the diagnostic.',
    };
  }

  let accessToken: string;
  try {
    accessToken = await decryptSecret(conn.accessTokenEncrypted);
  } catch (err) {
    return {
      ok: false,
      errorMessage: `Failed to decrypt Meta access token: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Run one diagnostic per attached ad account. Parallel — each is a
  // read-only 2-call probe (~1s total), and users rarely have more
  // than a handful of accounts attached anyway.
  const diagnostics = await Promise.all(
    adAccountIds.map((adAccountId) => diagnoseAdAccount({ accessToken, adAccountId })),
  );

  await logAuditEvent({
    userId: user.id,
    eventType: 'meta_diagnostic_ran',
    eventData: {
      ad_account_count: adAccountIds.length,
      any_launchable: diagnostics.some((d) => d.status?.isLaunchable === true),
      any_sac_enrolled: diagnostics.some((d) => d.isEnrolledInSpecialAdCategory === true),
      any_disable_reason: diagnostics.some((d) => (d.disableReason?.code ?? 0) !== 0),
    },
  });

  return { ok: true, diagnostics };
}
