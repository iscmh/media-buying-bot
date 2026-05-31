import type { FootballFixture, OddsEvent } from './types.js';

const NOISE = new Set(['fc', 'cf', 'sc', 'afc', 'cd', 'ac', 'club', 'de', 'the', 'city', 'united']);

function normalize(name: string): Set<string> {
  return new Set(
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // strip diacritics
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t && !NOISE.has(t)),
  );
}

/** Token-overlap similarity (Jaccard) between two team names, 0..1. */
function similarity(a: string, b: string): number {
  const sa = normalize(a);
  const sb = normalize(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Find the football fixture that best matches an odds event by team names and
 * kickoff day. Returns the fixtureId, or undefined if nothing crosses the bar.
 */
export function matchFixture(event: OddsEvent, fixtures: FootballFixture[]): number | undefined {
  const eventDay = event.commence_time.slice(0, 10);
  let best: { id: number; score: number } | undefined;

  for (const fx of fixtures) {
    if (fx.date.slice(0, 10) !== eventDay) continue;
    const score = similarity(event.home_team, fx.home) + similarity(event.away_team, fx.away);
    if (!best || score > best.score) best = { id: fx.fixtureId, score };
  }
  // Require a reasonably strong combined match (max is 2.0).
  return best && best.score >= 1.0 ? best.id : undefined;
}
