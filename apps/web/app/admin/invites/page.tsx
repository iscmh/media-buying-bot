import { countFoundingMembers, listInviteCodes } from '@mbb/db';
import { FOUNDING_MEMBER_CAP } from '@mbb/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AppShell } from '@/components/shell/app-shell';
import { formatDateTime } from '@/lib/format/date';
import { requireAdmin } from '@/lib/admin-gate';
import { InvitesClient } from './invites-client';

export const metadata = { title: 'Invite codes — Admin' };
export const dynamic = 'force-dynamic';

export default async function AdminInvitesPage() {
  await requireAdmin();
  const [codes, foundingCount] = await Promise.all([listInviteCodes(), countFoundingMembers()]);

  return (
    <AppShell crumbs={[{ label: 'Admin' }, { label: 'Invites' }]} contentClass="max-w-5xl">
      <header className="mb-6">
        <h1 className="text-fg text-2xl font-semibold tracking-tight">Invite codes</h1>
        <p className="text-fg-muted mt-1 text-sm">
          Generate codes for direct invites. Codes are single-use and expire after 30 days unless
          you flip multi-use.
        </p>
      </header>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Founding members</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">
            <strong>{foundingCount}</strong> of <strong>{FOUNDING_MEMBER_CAP}</strong> slots
            claimed.{' '}
            {foundingCount >= FOUNDING_MEMBER_CAP ? (
              <span className="text-muted-foreground">
                Cap reached — new signups are regular users.
              </span>
            ) : (
              <span className="text-muted-foreground">
                Next {FOUNDING_MEMBER_CAP - foundingCount} signups auto-flag as founding.
              </span>
            )}
          </p>
        </CardContent>
      </Card>

      <InvitesClient
        codes={codes.map((c) => ({
          id: c.id,
          code: c.code,
          isMultiUse: c.isMultiUse,
          maxUses: c.maxUses,
          useCount: c.useCount,
          expiresAtIso: c.expiresAt.toISOString(),
          revokedAtIso: c.revokedAt?.toISOString() ?? null,
          createdAtIso: c.createdAt.toISOString(),
          statusLabel: statusFor({
            expiresAt: c.expiresAt,
            revokedAt: c.revokedAt,
            useCount: c.useCount,
            maxUses: c.maxUses,
          }),
        }))}
      />

      <p className="text-fg-muted mt-6 text-xs">
        Latest server time: {formatDateTime(new Date())}.
      </p>
    </AppShell>
  );
}

function statusFor(input: {
  expiresAt: Date;
  revokedAt: Date | null;
  useCount: number;
  maxUses: number;
}): 'active' | 'expired' | 'revoked' | 'fully_used' {
  if (input.revokedAt) return 'revoked';
  if (input.expiresAt <= new Date()) return 'expired';
  if (input.useCount >= input.maxUses) return 'fully_used';
  return 'active';
}
