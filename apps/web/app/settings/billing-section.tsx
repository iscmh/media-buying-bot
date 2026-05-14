import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/lib/format/date';

interface Props {
  isFoundingMember: boolean;
  plan: 'monthly' | 'annual' | 'lifetime' | null;
  status: 'active' | 'past_due' | 'canceled' | 'expired' | null;
  currentPeriodEnd: Date | null;
  adAccountSlotsUsed: number;
  adAccountSlotsLimit: number;
  whopAddonProductId: string | null;
}

/**
 * Phase 8: read-only billing summary that lives on the settings page.
 * Founding members get a perpetual-access treatment with no Whop links.
 * Everyone else sees their plan + period end + "Manage on Whop" CTA.
 *
 * Ad-account slot quota is shown alongside so an operator knows when
 * to grab another slot before the connect-Meta flow blocks them.
 */
export function BillingSection({
  isFoundingMember,
  plan,
  status,
  currentPeriodEnd,
  adAccountSlotsUsed,
  adAccountSlotsLimit,
  whopAddonProductId,
}: Props) {
  if (isFoundingMember) {
    return (
      <Card className="mb-8">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Billing</CardTitle>
            <Badge variant="gold">⭐ Founding Member</Badge>
          </div>
        </CardHeader>
        <CardContent className="text-sm">
          <p>Perpetual access. No subscription required.</p>
          <p className="text-muted-foreground mt-2 text-xs">
            Ad account slots: {adAccountSlotsUsed} of {adAccountSlotsLimit} used.
          </p>
        </CardContent>
      </Card>
    );
  }

  const planLabel = plan ?? '—';
  const statusLabel = status ?? 'none';

  return (
    <Card className="mb-8">
      <CardHeader>
        <CardTitle className="text-base">Billing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <p className="text-muted-foreground text-xs">Plan</p>
            <p className="font-medium capitalize">{planLabel}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Status</p>
            <p className="font-medium capitalize">{statusLabel.replace(/_/g, ' ')}</p>
          </div>
          {currentPeriodEnd && (
            <div>
              <p className="text-muted-foreground text-xs">
                {status === 'canceled' ? 'Access ends' : 'Renews'}
              </p>
              <p className="font-medium">{formatDateTime(currentPeriodEnd)}</p>
            </div>
          )}
          <div>
            <p className="text-muted-foreground text-xs">Ad account slots</p>
            <p className="font-medium">
              {adAccountSlotsUsed} / {adAccountSlotsLimit}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          <Button asChild variant="outline" size="sm">
            <a href="https://whop.com/orders" target="_blank" rel="noopener noreferrer">
              Manage billing on Whop ↗
            </a>
          </Button>
          {whopAddonProductId && (
            <Button asChild variant="outline" size="sm">
              <a
                href={`https://whop.com/checkout/${encodeURIComponent(whopAddonProductId)}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Add another ad account slot · $49/mo ↗
              </a>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
