'use client';

/**
 * Polish-28.4.2 Commit 100: Meta ad-account diagnostic UI.
 *
 * Renders a "Run diagnostic" button below the connected-summary block.
 * On click, calls runMetaDiagnosticAction and displays one card per
 * attached ad account with color-coded findings. Meta's raw response
 * is stashed in a collapsible <details> so an operator can copy-paste
 * to support if a finding is ambiguous.
 */

import * as React from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, Info, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { runMetaDiagnosticAction, type RunMetaDiagnosticResult } from './diagnostic-action';

type Diagnostic = NonNullable<RunMetaDiagnosticResult['diagnostics']>[number];

export function MetaDiagnosticPanel(): React.ReactElement {
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<RunMetaDiagnosticResult | null>(null);

  async function run() {
    setRunning(true);
    try {
      const r = await runMetaDiagnosticAction();
      setResult(r);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="border-border-subtle bg-bg-surface space-y-3 rounded-md border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-fg text-sm font-medium">Ad account diagnostic</p>
          <p className="text-fg-muted mt-1 text-xs leading-relaxed">
            Reads Meta&apos;s account_status, disable_reason, capabilities, and funding source for
            each attached account. Flags the failure modes that produce cryptic launch errors
            (Special Ad Category enforcement, pending risk review, missing payment, insufficient
            token scopes).
          </p>
        </div>
        <Button type="button" onClick={run} disabled={running} variant="outline" size="sm">
          {running ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Running…
            </>
          ) : (
            'Run diagnostic'
          )}
        </Button>
      </div>

      {result && !result.ok && (
        <div className="border-[color:var(--accent-negative)]/40 bg-[color:var(--accent-negative)]/5 rounded-md border p-3 text-xs">
          <p className="text-fg font-medium">Diagnostic couldn&apos;t run</p>
          <p className="text-fg-muted mt-1">{result.errorMessage}</p>
        </div>
      )}

      {result?.diagnostics?.map((d) => (
        <DiagnosticCard key={d.adAccountId} diagnostic={d} />
      ))}
    </div>
  );
}

function DiagnosticCard({ diagnostic }: { diagnostic: Diagnostic }): React.ReactElement {
  const headerColor = diagnostic.ok
    ? 'border-[color:var(--accent-positive)]/40 bg-[color:var(--accent-positive)]/5'
    : 'border-[color:var(--accent-negative)]/40 bg-[color:var(--accent-negative)]/5';

  return (
    <div className={cn('space-y-2 rounded-md border p-3', headerColor)}>
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-fg text-sm font-medium">
            {diagnostic.accountName ?? diagnostic.adAccountId}
          </p>
          <p className="text-fg-muted font-mono text-[11px]">{diagnostic.adAccountId}</p>
        </div>
        <div className="text-fg-muted text-[11px]">
          {diagnostic.currency ?? '—'} · {diagnostic.timezoneName ?? '—'}
        </div>
      </div>

      <ul className="space-y-1.5">
        {diagnostic.findings.map((f, i) => (
          <FindingRow key={i} finding={f} />
        ))}
      </ul>

      <details className="mt-2">
        <summary className="text-fg-muted flex cursor-pointer items-center gap-1 text-[11px]">
          <ChevronDown className="h-3 w-3" />
          Raw Meta response
        </summary>
        <pre className="bg-bg-elevated mt-1 max-h-64 overflow-auto rounded p-2 font-mono text-[10px]">
          {JSON.stringify(diagnostic.rawResponse, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function FindingRow({ finding }: { finding: Diagnostic['findings'][number] }): React.ReactElement {
  const Icon =
    finding.severity === 'ok'
      ? CheckCircle2
      : finding.severity === 'error' || finding.severity === 'warning'
        ? AlertCircle
        : Info;
  const color =
    finding.severity === 'ok'
      ? 'text-[color:var(--accent-positive)]'
      : finding.severity === 'error'
        ? 'text-[color:var(--accent-negative)]'
        : finding.severity === 'warning'
          ? 'text-[color:var(--accent-warning)]'
          : 'text-fg-muted';

  return (
    <li className="flex items-start gap-2 text-xs leading-relaxed">
      <Icon className={cn('mt-0.5 h-3.5 w-3.5 flex-none', color)} />
      <div className="min-w-0 flex-1">
        <p className="text-fg font-medium">{finding.title}</p>
        <p className="text-fg-muted mt-0.5">{finding.detail}</p>
        {finding.suggestion && (
          <p className="text-fg mt-1 text-[11px] italic">→ {finding.suggestion}</p>
        )}
      </div>
    </li>
  );
}
