import { redirect } from 'next/navigation';
import { getCreditBalance, getCreditHistory } from '@mbb/db';
import { CREDIT_UNIT_USD, PRO_INCLUDED_CREDITS } from '@mbb/shared';
import { AppShell } from '@/components/shell/app-shell';
import { TopupButtons } from '@/components/credits/topup-buttons';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export const metadata = { title: 'Credits — settings' };
export const dynamic = 'force-dynamic';

/**
 * Polish-29.0.3 Commit 113: dedicated credits page. Three sections:
 *   1. Balance summary — current balance + lifetime purchased/spent
 *   2. Top-up packs — three buttons wired to Whop checkout
 *   3. History — most recent 50 credit_transactions rows
 *
 * The balance also shows on every page via the top-toolbar pill;
 * this page is the drill-down for anyone who wants context on where
 * the credits went.
 */
export default async function CreditsSettingsPage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [balance, history] = await Promise.all([
    getCreditBalance(user.id),
    getCreditHistory(user.id, 50),
  ]);

  return (
    <AppShell
      crumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Credits' }]}
      contentClass="max-w-4xl"
    >
      <div className="space-y-8">
        <section aria-labelledby="balance-heading" className="space-y-3">
          <h1 id="balance-heading" className="text-fg text-xl font-semibold">
            Credits
          </h1>
          <p className="text-fg-muted text-sm">
            1 credit = ${CREDIT_UNIT_USD.toFixed(2)}. PRO includes{' '}
            {PRO_INCLUDED_CREDITS.toLocaleString()} credits every month.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard label="Current balance" value={balance.balance} tone="primary" />
            <StatCard label="Lifetime purchased" value={balance.lifetimePurchased} />
            <StatCard label="Lifetime spent" value={balance.lifetimeSpent} />
          </div>
        </section>

        <section aria-labelledby="topup-heading" className="space-y-3">
          <h2 id="topup-heading" className="text-fg text-base font-semibold">
            Buy more credits
          </h2>
          <p className="text-fg-muted text-sm">
            One-off top-ups on Whop. Credits land in your account within seconds of the payment
            clearing.
          </p>
          <TopupButtons />
        </section>

        <section aria-labelledby="history-heading" className="space-y-3">
          <h2 id="history-heading" className="text-fg text-base font-semibold">
            Recent history
          </h2>
          {history.length === 0 ? (
            <p className="text-fg-muted text-sm">
              No credit transactions yet. Your signup credits should appear here after your first
              login; every generation and top-up will show up too.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="border-border w-full border-collapse text-sm">
                <thead>
                  <tr className="text-fg-muted border-b text-left text-xs uppercase tracking-wider">
                    <th className="py-2 pr-3">When</th>
                    <th className="py-2 pr-3">Type</th>
                    <th className="py-2 pr-3">Description</th>
                    <th className="py-2 pr-3 text-right">Δ</th>
                    <th className="py-2 pr-3 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((row) => (
                    <tr key={row.id} className="border-border border-b last:border-0">
                      <td className="text-fg-muted whitespace-nowrap py-2 pr-3 text-xs tabular-nums">
                        {formatDate(row.createdAt)}
                      </td>
                      <td className="py-2 pr-3">
                        <TypeBadge type={row.type} />
                      </td>
                      <td className="text-fg-muted py-2 pr-3">{row.description ?? '—'}</td>
                      <td
                        className={
                          row.delta >= 0
                            ? 'py-2 pr-3 text-right font-mono text-xs tabular-nums text-emerald-600 dark:text-emerald-400'
                            : 'py-2 pr-3 text-right font-mono text-xs tabular-nums text-red-600 dark:text-red-400'
                        }
                      >
                        {row.delta > 0 ? '+' : ''}
                        {row.delta.toLocaleString()}
                      </td>
                      <td className="text-fg py-2 pr-3 text-right font-mono text-xs tabular-nums">
                        {row.balanceAfter.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}

// -----------------------------------------------------------------
// Small presentational bits — kept in-file since they're only used here.
// -----------------------------------------------------------------

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'primary' | 'default';
}) {
  return (
    <div
      className={
        tone === 'primary'
          ? 'border-border bg-bg-surface rounded-lg border p-4'
          : 'border-border bg-bg-surface rounded-lg border p-4'
      }
    >
      <div className="text-fg-muted text-xs uppercase tracking-wider">{label}</div>
      <div className="text-fg mt-1 text-2xl font-semibold tabular-nums">
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function TypeBadge({ type }: { type: string }) {
  const label = TYPE_LABELS[type] ?? type;
  const cls = TYPE_TONES[type] ?? 'bg-bg-surface text-fg-muted border-border';
  return (
    <span
      className={
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ' + cls
      }
    >
      {label}
    </span>
  );
}

const TYPE_LABELS: Record<string, string> = {
  signup_trial: 'Signup trial',
  purchase: 'Purchase',
  sub_monthly_topup: 'PRO monthly',
  sub_bonus: 'Bonus',
  spend: 'Spend',
  refund_on_fail: 'Refund',
  admin_adjust: 'Admin adjustment',
  chargeback_reverse: 'Chargeback',
};

const TYPE_TONES: Record<string, string> = {
  signup_trial:
    'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900/60',
  purchase:
    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900/60',
  sub_monthly_topup:
    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900/60',
  sub_bonus:
    'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900/60',
  spend: 'bg-bg-surface text-fg-muted border-border',
  refund_on_fail:
    'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-950/40 dark:text-slate-300 dark:border-slate-900/60',
  admin_adjust:
    'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-900/60',
  chargeback_reverse:
    'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900/60',
};

function formatDate(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
