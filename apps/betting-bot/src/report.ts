/** Human-readable report rendering for scan results. */

import type { ValueBet } from './types.js';

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function american(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

export function renderReport(bets: ValueBet[], bankroll: number): string {
  const lines: string[] = [];
  lines.push(`# Value scan — ${new Date().toISOString()}`);
  lines.push('');

  if (bets.length === 0) {
    lines.push(
      'No bets cleared the edge threshold. That is the normal result — ' +
        'most days the market is efficient. Do not lower the threshold ' +
        'just to have action.',
    );
    return lines.join('\n');
  }

  lines.push(`Found ${bets.length} candidate value bet(s) (bankroll ${bankroll}):`);
  lines.push('');

  for (const [i, bet] of bets.entries()) {
    const pointStr = bet.point !== undefined ? ` ${bet.point}` : '';
    lines.push(
      `## ${i + 1}. ${bet.outcome}${pointStr} (${bet.market}) — ` +
        `${bet.game.awayTeam} @ ${bet.game.homeTeam}`,
    );
    lines.push(`- Kickoff: ${bet.game.commenceTime}`);
    lines.push(
      `- Best price: ${american(bet.bestAmerican)} (${bet.bestDecimal.toFixed(3)}) at ${bet.bestBook}`,
    );
    lines.push(
      `- Fair (no-vig consensus, ${bet.bookCount} books): ${pct(bet.fairProb)} → ${bet.fairDecimal.toFixed(3)}`,
    );
    lines.push(`- Edge (EV): ${pct(bet.ev)} | full Kelly: ${pct(bet.kelly)}`);
    lines.push(`- Suggested stake (fractional Kelly, capped): ${bet.stake}`);
    if (bet.aiReview) {
      lines.push(
        `- AI verdict: ${bet.aiReview.verdict.toUpperCase()} ` +
          `(confidence ${bet.aiReview.confidence})`,
      );
      if (bet.aiReview.reasoning) lines.push(`  - ${bet.aiReview.reasoning}`);
      for (const flag of bet.aiReview.riskFlags) {
        lines.push(`  - ⚠ ${flag}`);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(
    'Reminder: edges of 2-5% lose often. Flat small stakes, never chase, ' +
      'and expect the books to limit winning accounts. Bet only what you ' +
      'can afford to lose.',
  );
  return lines.join('\n');
}
