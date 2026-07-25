/**
 * Polish-25.5 Commit 27: row-level ROI tone utility.
 *
 * Voluum/RedTrack row-shading: the whole table row tints green if
 * profitable, red if losing, neutral if not enough data to tell.
 * A media buyer scanning 100+ ads should read pass/fail at a glance.
 *
 * Empty-state safety (operator requirement 3): if there's no spend
 * yet, or fewer than $1 spent, the tone is "neutral" — never render
 * a "losing" red band on a row that hasn't had a chance to spend.
 */
export type RoiTone = 'positive' | 'negative' | 'neutral';

export function roiTone({
  spendUsd,
  roas,
  breakEvenRoas = 1,
  goodRoas = 2,
  minSpendUsd = 1,
}: {
  spendUsd: number;
  roas: number | null | undefined;
  breakEvenRoas?: number;
  goodRoas?: number;
  minSpendUsd?: number;
}): RoiTone {
  if (!spendUsd || spendUsd < minSpendUsd) return 'neutral';
  if (roas == null) return 'neutral';
  if (roas >= goodRoas) return 'positive';
  if (roas < breakEvenRoas) return 'negative';
  return 'neutral';
}

/**
 * Tailwind class fragments for row background tint. Kept extremely
 * subtle — 4% opacity — so the whole table doesn't scream red/green.
 * Voluum's canonical shading is aggressive; on a black bg the same
 * intensity blows out. 4% reads as "hint of tint," which is right
 * for a dark UI.
 */
export function roiRowClass(tone: RoiTone): string {
  if (tone === 'positive') return 'bg-[color:var(--accent-positive)]/[0.04]';
  if (tone === 'negative') return 'bg-[color:var(--accent-negative)]/[0.04]';
  return '';
}

/**
 * Text tone for the ROAS cell itself — a stronger signal than the
 * row-wide band. This one is 100% opacity because it's a small cell.
 */
export function roiTextClass(tone: RoiTone): string {
  if (tone === 'positive') return 'text-[color:var(--accent-positive)]';
  if (tone === 'negative') return 'text-[color:var(--accent-negative)]';
  return 'text-fg';
}
