import type { Page } from 'playwright';
import { goto } from './browser.js';
import type { Bet, Config, MatchLink, MatchPrediction, Sport } from './types.js';

/** Resolve a possibly-relative href against the base, returning null if invalid. */
function absolute(href: string, base: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/**
 * Discover available sports from the site navigation. We read every nav/menu
 * link and keep the ones whose text matches a known sport keyword.
 */
export async function discoverSports(page: Page, config: Config): Promise<Sport[]> {
  await goto(page, config.baseUrl);

  const links = await page.$$eval(config.selectors.navLinks, (els) =>
    els
      .map((el) => {
        const a = el as HTMLAnchorElement;
        return { text: (a.textContent ?? '').replace(/\s+/g, ' ').trim(), href: a.href };
      })
      .filter((l) => l.text && l.href),
  );

  const seen = new Set<string>();
  const sports: Sport[] = [];
  for (const link of links) {
    const lower = link.text.toLowerCase();
    const match = config.knownSports.find(
      (s) => lower === s || lower.startsWith(s) || lower.includes(` ${s}`),
    );
    if (!match) continue;
    const url = absolute(link.href, config.baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    // Title-case the matched sport keyword for display.
    const name = match.replace(/\b\w/g, (c) => c.toUpperCase());
    sports.push({ name, url });
  }
  return sports;
}

/**
 * From a sport hub page, collect links that look like individual match
 * prediction pages (e.g. "Team A vs Team B Prediction").
 */
export async function listMatches(
  page: Page,
  sportUrl: string,
  config: Config,
): Promise<MatchLink[]> {
  await goto(page, sportUrl);

  const raw = await page.$$eval(config.selectors.matchLinks, (els) =>
    els
      .map((el) => {
        const a = el as HTMLAnchorElement;
        return { text: (a.textContent ?? '').replace(/\s+/g, ' ').trim(), href: a.href };
      })
      .filter((l) => l.href),
  );

  const seen = new Set<string>();
  const matches: MatchLink[] = [];
  // Looks like a fixture: "X vs Y", "X v Y", or "X - Y" with words on each side.
  const fixtureRe = /\w[\w .'-]*\s+(?:vs?\.?|-|–)\s+\w[\w .'-]*/i;
  for (const link of raw) {
    const url = absolute(link.href, config.baseUrl);
    if (!url || url === sportUrl || seen.has(url)) continue;
    const looksLikeFixture =
      fixtureRe.test(link.text) || /prediction/i.test(url);
    if (!looksLikeFixture) continue;
    seen.add(url);
    matches.push({ title: link.text || url, url });
  }
  return matches;
}

/** Scrape one match prediction page for teams, meta, and all bet markets. */
export async function scrapeMatch(
  page: Page,
  match: MatchLink,
  config: Config,
): Promise<MatchPrediction> {
  await goto(page, match.url);

  const data = await page.evaluate((sel) => {
    const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    const first = (selector: string): string | undefined => {
      for (const part of selector.split(',')) {
        const el = document.querySelector(part.trim());
        const t = clean(el?.textContent);
        if (t) return t;
      }
      return undefined;
    };

    const teams = first(sel.teams);
    const league = first(sel.league);
    const kickoff = first(sel.kickoff);

    // --- Bet extraction -------------------------------------------------
    // Keywords that signal a betting market / prediction.
    const marketKeywords = [
      'prediction',
      'tip',
      'correct score',
      'both teams to score',
      'btts',
      'over',
      'under',
      'double chance',
      'win',
      'draw',
      'handicap',
      'goals',
      'half time',
      'full time',
      'clean sheet',
      'odds',
      'probability',
      'to score',
      '1x2',
    ];
    const looksLikeMarket = (label: string) => {
      const l = label.toLowerCase();
      return marketKeywords.some((k) => l.includes(k));
    };

    const bets: { market: string; value: string }[] = [];
    const pushed = new Set<string>();
    const add = (market: string, value: string) => {
      market = clean(market);
      value = clean(value);
      if (!market || !value || market === value) return;
      if (market.length > 80 || value.length > 160) return;
      const key = `${market}::${value}`.toLowerCase();
      if (pushed.has(key)) return;
      pushed.add(key);
      bets.push({ market, value });
    };

    // 1) Tables: treat each row as label -> value pairs.
    document.querySelectorAll('table tr').forEach((tr) => {
      const cells = Array.from(tr.querySelectorAll('th, td')).map((c) => clean(c.textContent));
      if (cells.length >= 2 && cells[0]) {
        const label = cells[0];
        const value = cells.slice(1).filter(Boolean).join(' | ');
        if (value && (looksLikeMarket(label) || looksLikeMarket(value))) add(label, value);
      }
    });

    // 2) Definition-style / labeled blocks within prediction containers.
    document.querySelectorAll(sel.predictionBlocks).forEach((block) => {
      // label: value pattern in a single element's text
      const text = clean(block.textContent);
      const m = text.match(/^([^:]{2,60}):\s*(.+)$/);
      if (m && m[1] && m[2] && looksLikeMarket(m[1])) add(m[1], m[2]);

      // strong/b label followed by sibling text
      block.querySelectorAll('strong, b, dt, .label, .title').forEach((labelEl) => {
        const label = clean(labelEl.textContent);
        if (!label || !looksLikeMarket(label)) return;
        const valueEl = labelEl.nextElementSibling;
        const value = clean(valueEl?.textContent) || clean(labelEl.parentElement?.textContent).replace(label, '');
        if (value) add(label, value);
      });
    });

    return { teams, league, kickoff, bets };
  }, config.selectors);

  return {
    title: match.title,
    url: match.url,
    teams: data.teams,
    league: data.league,
    kickoff: data.kickoff,
    bets: data.bets as Bet[],
  };
}
