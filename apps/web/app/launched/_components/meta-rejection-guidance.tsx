import { AlertTriangle, ExternalLink, Info } from 'lucide-react';
import { interpretMetaError, type MetaErrorCategory } from '@mbb/shared';

/**
 * Polish-25.6 Commit 38: rendered below the raw Meta error message on
 * any /launched row whose status is `rejected_by_meta` or
 * `launch_failed`. Turns Meta's opaque rejection strings into
 * actionable guidance — most notably surfacing "your ad account is in
 * a Special Ad Category" when Meta only tells you "add a higher
 * minimum age suggestion" in the user's BM language.
 *
 * Categories are amber for restriction / policy issues (fixable) and
 * red for permission / auth (need to reconnect). Falls back to a
 * generic hint on unknown patterns so buyers never see a raw error
 * with no next-step guidance.
 */

interface Props {
  errorMessage: string | null | undefined;
}

// Polish-25.7 Commit 43: `safety_layer` is user-actionable (the launch
// never reached Meta — the bot's own safety net stopped it), not Meta
// enforcement. Renders in blue / info tone to distinguish it from a
// real Meta rejection (amber) or auth loss (red).
const CATEGORY_TONE: Record<MetaErrorCategory, 'warning' | 'destructive' | 'neutral' | 'info'> = {
  safety_layer: 'info',
  special_ad_category: 'warning',
  policy_creative: 'warning',
  policy_landing: 'warning',
  budget_currency: 'warning',
  permissions: 'destructive',
  meta_api_required_field: 'warning',
  other: 'neutral',
};

export function MetaRejectionGuidance({ errorMessage }: Props) {
  if (!errorMessage) return null;
  const guidance = interpretMetaError(errorMessage);
  const tone = CATEGORY_TONE[guidance.category];

  const borderClass =
    tone === 'destructive'
      ? 'border-[color:var(--accent-negative)]/50 bg-[color:var(--accent-negative)]/5'
      : tone === 'warning'
        ? 'border-[color:var(--accent-warning)]/40 bg-[color:var(--accent-warning)]/5'
        : tone === 'info'
          ? 'border-[color:var(--accent-info,#3b82f6)]/50 bg-[color:var(--accent-info,#3b82f6)]/5'
          : 'border-border bg-bg-inset';

  const iconClass =
    tone === 'destructive'
      ? 'text-[color:var(--accent-negative)]'
      : tone === 'warning'
        ? 'text-[color:var(--accent-warning)]'
        : tone === 'info'
          ? 'text-[color:var(--accent-info,#3b82f6)]'
          : 'text-fg-muted';

  const IconComponent = tone === 'info' ? Info : AlertTriangle;

  return (
    <div
      className={`mt-2 flex gap-2 rounded-sm border p-2 text-xs leading-snug ${borderClass}`}
      role="note"
    >
      <IconComponent className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${iconClass}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-fg font-medium">{guidance.title}</p>
        <p className="text-fg-muted mt-0.5">{guidance.diagnosis}</p>
        {guidance.fixes.length > 0 && (
          <ul className="text-fg-muted mt-1.5 list-disc space-y-0.5 pl-4">
            {guidance.fixes.map((fix, i) => (
              <li key={i}>{fix}</li>
            ))}
          </ul>
        )}
        {guidance.docsUrl && (
          <a
            href={guidance.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-fg mt-1.5 inline-flex items-center gap-1 text-[11px] underline-offset-4 hover:text-[color:var(--accent-amber)] hover:underline"
          >
            Meta docs
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        )}
      </div>
    </div>
  );
}
