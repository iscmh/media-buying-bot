import 'server-only';
import { headers } from 'next/headers';

/**
 * Pull IP + user-agent from the request headers for embedding into audit
 * log `event_data._meta`. We don't extend the audit_logs schema for this —
 * JSONB is fine at our volume and avoids a migration.
 *
 * IP resolution order: x-forwarded-for (first hop) → x-real-ip → null.
 * Vercel + Cloudflare both populate x-forwarded-for; in dev the headers
 * are usually missing, which is fine (null IP).
 */
export interface AuditRequestMeta {
  ip_address: string | null;
  user_agent: string | null;
}

export async function auditMetaFromHeaders(): Promise<AuditRequestMeta> {
  const h = await headers();
  const xff = h.get('x-forwarded-for');
  const xri = h.get('x-real-ip');
  const ip = xff?.split(',')[0]?.trim() ?? xri ?? null;
  const ua = h.get('user-agent');
  return { ip_address: ip || null, user_agent: ua ?? null };
}
