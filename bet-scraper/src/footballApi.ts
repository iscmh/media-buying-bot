import type { FootballFixture, FootballPrediction } from './types.js';

const BASE = 'https://v3.football.api-sports.io';

interface Envelope<T> {
  errors: unknown;
  results: number;
  response: T;
}

async function get<T>(path: string, params: Record<string, string>, key: string): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, { headers: { 'x-apisports-key': key } });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403)
      throw new Error('API-Football rejected the key. Check API_FOOTBALL_KEY.');
    if (res.status === 429) throw new Error('API-Football rate limit hit (429).');
    throw new Error(`API-Football ${res.status}`);
  }
  const env = (await res.json()) as Envelope<T>;
  if (env.errors && typeof env.errors === 'object' && Object.keys(env.errors).length > 0) {
    throw new Error(`API-Football error: ${JSON.stringify(env.errors).slice(0, 200)}`);
  }
  return env.response;
}

interface RawFixture {
  fixture: { id: number; date: string };
  teams: { home: { name: string }; away: { name: string } };
  league: { name: string; country: string };
}

/** All fixtures on a given YYYY-MM-DD (UTC). One call covers every league. */
export async function getFixturesByDate(date: string, key: string): Promise<FootballFixture[]> {
  const raw = await get<RawFixture[]>('/fixtures', { date, timezone: 'UTC' }, key);
  return raw.map((f) => ({
    fixtureId: f.fixture.id,
    date: f.fixture.date,
    home: f.teams.home.name,
    away: f.teams.away.name,
    league: `${f.league.country} — ${f.league.name}`,
  }));
}

interface RawPrediction {
  predictions: {
    winner: { name: string | null; comment: string | null } | null;
    advice: string | null;
    percent: { home: string; draw: string; away: string };
  };
}

export async function getPrediction(
  fixtureId: number,
  key: string,
): Promise<FootballPrediction | undefined> {
  const raw = await get<RawPrediction[]>('/predictions', { fixture: String(fixtureId) }, key);
  const p = raw[0]?.predictions;
  if (!p) return undefined;
  return {
    winner: p.winner?.name ?? undefined,
    advice: p.advice ?? undefined,
    percent: { home: p.percent.home, draw: p.percent.draw, away: p.percent.away },
  };
}
