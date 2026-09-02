'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  testDailySummary,
  testKillAction,
  testScaleAction,
  testSeedanceGeneration,
} from './actions';

interface Ad {
  id: string;
  metaAdId: string | null;
  status: string;
  dailyBudgetUsd: string;
  spendUsd: string | null;
}

export function TestActionsClient({ ads }: { ads: Ad[] }) {
  const [selectedAdId, setSelectedAdId] = React.useState(ads[0]?.id ?? '');
  const [scaleBudget, setScaleBudget] = React.useState(15);
  const [result, setResult] = React.useState<{ ok: boolean; message: string } | null>(null);
  const [pending, setPending] = React.useState(false);
  // Polish-29.0.6 Commit 115 — Seedance credit-flow smoke test inputs.
  const [seedancePrompt, setSeedancePrompt] = React.useState(
    'A cinematic 5-second hero shot of a golden retriever running along a sunlit beach at dawn.',
  );
  const [dreaminaAccount, setDreaminaAccount] = React.useState('US:isaacisverygoatedtho@gmail.com');

  async function runAction(fn: () => Promise<{ ok: boolean; message: string }>) {
    setPending(true);
    setResult(null);
    try {
      const r = await fn();
      setResult(r);
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setPending(false);
    }
  }

  const selectedAd = ads.find((a) => a.id === selectedAdId);

  return (
    <div className="space-y-6">
      {/* Ad picker */}
      <div className="space-y-2">
        <Label htmlFor="adSelect">Launched ad</Label>
        <select
          id="adSelect"
          className="bg-bg-elevated text-fg border-border w-full rounded-md border px-3 py-2 font-mono text-sm"
          value={selectedAdId}
          onChange={(e) => setSelectedAdId(e.target.value)}
        >
          {ads.map((ad) => (
            <option key={ad.id} value={ad.id}>
              {ad.id.slice(0, 8)} | {ad.status} | ${ad.dailyBudgetUsd}/day |{' '}
              {ad.spendUsd ? `$${ad.spendUsd} spent` : 'no spend'} |{' '}
              {ad.metaAdId ? ad.metaAdId.slice(0, 12) : 'no meta id'}
            </option>
          ))}
        </select>
        {ads.length === 0 && <p className="text-fg-muted text-sm">No launched ads found.</p>}
      </div>

      {/* Action buttons */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="bg-bg-elevated space-y-3 rounded-md border p-4">
          <p className="text-fg text-sm font-medium">Test Kill</p>
          <p className="text-fg-muted text-xs">
            Creates a pending approval + immediately confirms it. Dispatches pauseAd via Meta API,
            updates status to killed, sends Telegram.
          </p>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending || !selectedAdId}
            onClick={() => runAction(() => testKillAction(selectedAdId))}
          >
            {pending ? 'Running...' : 'Test Kill'}
          </Button>
        </div>

        <div className="bg-bg-elevated space-y-3 rounded-md border p-4">
          <p className="text-fg text-sm font-medium">Test Scale</p>
          <p className="text-fg-muted text-xs">
            Creates a scale approval to the specified budget and confirms it. Updates
            daily_budget_usd via Meta API.
          </p>
          <div className="flex items-center gap-2">
            <span className="text-fg-muted text-sm">$</span>
            <Input
              type="number"
              min={1}
              value={scaleBudget}
              onChange={(e) => setScaleBudget(Number(e.target.value) || 0)}
              className="font-mono"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || !selectedAdId || scaleBudget <= 0}
            onClick={() => runAction(() => testScaleAction(selectedAdId, scaleBudget))}
          >
            {pending ? 'Running...' : 'Test Scale'}
          </Button>
        </div>

        <div className="bg-bg-elevated space-y-3 rounded-md border p-4 sm:col-span-3">
          <p className="text-fg text-sm font-medium">
            Test Seedance Generation (credits) — Polish-29.0.6
          </p>
          <p className="text-fg-muted text-xs">
            Fires a real credit-backed Seedance job via useapi.net (Dreamina). Reserves 40 credits
            up-front, submits to Seedance 2.5, polls until done, consumes on success or refunds on
            failure. Watch Inngest for the <code>generate-polish29-seedance</code> run and the
            generation_jobs row's <code>metadata.polish29_seedance</code> for the video URL.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="seedancePrompt">Prompt</Label>
              <Input
                id="seedancePrompt"
                value={seedancePrompt}
                onChange={(e) => setSeedancePrompt(e.target.value)}
                placeholder="A cinematic 5-second hero shot of…"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dreaminaAccount">Dreamina account</Label>
              <Input
                id="dreaminaAccount"
                value={dreaminaAccount}
                onChange={(e) => setDreaminaAccount(e.target.value)}
                placeholder="US:you@example.com"
                className="font-mono"
              />
            </div>
          </div>
          <Button
            size="sm"
            disabled={pending || !seedancePrompt.trim() || !dreaminaAccount.trim()}
            onClick={() =>
              runAction(() =>
                testSeedanceGeneration({
                  prompt: seedancePrompt,
                  dreaminaAccount,
                }),
              )
            }
          >
            {pending ? 'Dispatching…' : 'Fire Seedance job'}
          </Button>
        </div>

        <div className="bg-bg-elevated space-y-3 rounded-md border p-4">
          <p className="text-fg text-sm font-medium">Test Daily Summary</p>
          <p className="text-fg-muted text-xs">
            Dispatches the daily-summary-generator for your user. Summary fires via Telegram if
            connected.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => runAction(() => testDailySummary())}
          >
            {pending ? 'Running...' : 'Test Summary'}
          </Button>
        </div>
      </div>

      {/* Selected ad details */}
      {selectedAd && (
        <div className="bg-bg-elevated text-fg-muted rounded-md border p-3 font-mono text-xs">
          <p>id: {selectedAd.id}</p>
          <p>meta_ad_id: {selectedAd.metaAdId ?? 'null'}</p>
          <p>status: {selectedAd.status}</p>
          <p>daily_budget_usd: ${selectedAd.dailyBudgetUsd}</p>
          <p>meta_spend_usd: {selectedAd.spendUsd ? `$${selectedAd.spendUsd}` : 'null'}</p>
        </div>
      )}

      {/* Result */}
      {result && (
        <div
          className={
            'rounded-md border p-3 text-sm ' +
            (result.ok
              ? 'bg-bg-elevated text-fg'
              : 'border-[color:var(--destructive-color)]/40 text-[color:var(--destructive-color)]')
          }
        >
          {result.message}
        </div>
      )}
    </div>
  );
}
