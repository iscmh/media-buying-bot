'use client';

import * as React from 'react';
import { useFormStatus } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AD_ACCOUNT_STATUS_LABELS,
  isAdAccountSelectable,
  type AdAccountRow,
  type BusinessRow,
} from '@/lib/meta/types';
import { selectMetaBusinessAction } from './actions';

interface Props {
  businesses: BusinessRow[];
  adAccounts: AdAccountRow[];
}

function SaveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="accent" disabled={disabled || pending} size="lg">
      {pending ? 'Saving…' : 'Save and continue'}
    </Button>
  );
}

export function MetaSelectionForm({ businesses, adAccounts }: Props) {
  const [bmId, setBmId] = React.useState<string>('');
  const [adAccountIds, setAdAccountIds] = React.useState<Set<string>>(new Set());
  const [error, setError] = React.useState<string | null>(null);

  // Group ad accounts by business id; "no business" bucket for accounts not in any BM.
  const grouped = React.useMemo(() => {
    const map = new Map<string, AdAccountRow[]>();
    for (const aa of adAccounts) {
      const key = aa.business?.id ?? '_unaffiliated';
      const list = map.get(key) ?? [];
      list.push(aa);
      map.set(key, list);
    }
    return map;
  }, [adAccounts]);

  function selectBM(id: string) {
    setBmId(id);
    setAdAccountIds(new Set()); // reset selections when BM changes
  }

  function toggleAdAccount(id: string) {
    setAdAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit(formData: FormData) {
    setError(null);
    const result = await selectMetaBusinessAction(formData);
    if (!result.ok) setError(result.errorMessage ?? 'Save failed.');
    // Success path: server action redirects.
  }

  if (businesses.length === 0) {
    return (
      <article className="mx-auto max-w-2xl">
        <header className="mb-6">
          <h1 className="text-3xl font-bold">Pick a Business Manager</h1>
        </header>
        <div className="border-destructive/50 bg-destructive/5 rounded-md border p-4 text-sm">
          <p className="font-semibold">No Business Managers visible on your token.</p>
          <p className="text-muted-foreground mt-1">
            Verify the token has the <code>business_management</code> scope and that the user who
            generated it is a member of at least one Business Manager.
          </p>
        </div>
      </article>
    );
  }

  return (
    <article className="mx-auto max-w-2xl">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">Pick a Business Manager</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Select one Business Manager and the ad accounts under it that the bot is allowed to
          manage. You can add or remove ad accounts later in settings.
        </p>
      </header>

      <form action={handleSubmit} className="space-y-6">
        <ul className="space-y-3">
          {businesses.map((bm) => {
            const accounts = grouped.get(bm.id) ?? [];
            const isSelected = bmId === bm.id;
            return (
              <li key={bm.id} className="bg-card rounded-lg border">
                <label className="flex cursor-pointer items-start gap-3 p-4">
                  <input
                    type="radio"
                    name="businessManagerId"
                    value={bm.id}
                    checked={isSelected}
                    onChange={() => selectBM(bm.id)}
                    className="mt-1 h-4 w-4"
                  />
                  <span>
                    <span className="block font-semibold">{bm.name}</span>
                    <span className="text-muted-foreground text-xs">
                      {accounts.length} ad account{accounts.length === 1 ? '' : 's'}
                    </span>
                  </span>
                </label>

                {isSelected && (
                  <ul className="bg-muted/30 border-t px-4 py-3">
                    {accounts.length === 0 && (
                      <li className="text-muted-foreground text-xs">
                        No ad accounts visible on this Business Manager.
                      </li>
                    )}
                    {accounts.map((aa) => {
                      const selectable = isAdAccountSelectable(aa.account_status);
                      const checked = adAccountIds.has(aa.id);
                      return (
                        <li key={aa.id} className="py-1">
                          <label
                            className={
                              'flex items-center gap-3 text-sm ' +
                              (selectable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60')
                            }
                          >
                            <input
                              type="checkbox"
                              name="adAccountIds"
                              value={aa.id}
                              checked={checked}
                              disabled={!selectable}
                              onChange={() => toggleAdAccount(aa.id)}
                              className="h-4 w-4"
                            />
                            <span className="font-mono text-xs">{aa.id}</span>
                            <span>{aa.name}</span>
                            {!selectable && (
                              <span className="ml-auto inline-flex items-center gap-1 text-xs text-[color:var(--destructive-color)]">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                {AD_ACCOUNT_STATUS_LABELS[aa.account_status] ?? 'unavailable'} -
                                reactivate before selecting
                              </span>
                            )}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>

        {error && (
          <div className="border-destructive/50 bg-destructive/5 rounded-md border p-3 text-sm">
            <p className="text-destructive">{error}</p>
          </div>
        )}

        <SaveButton disabled={!bmId || adAccountIds.size === 0} />
      </form>
    </article>
  );
}
