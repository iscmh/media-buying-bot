import { describe, expect, it } from 'vitest';
import { quotesFromPayload, renderJson, type EndpointConfig } from '../src/sources/api.js';
import { pickCardTotal } from '../src/sources/browser.js';
import { MockSource } from '../src/sources/mock.js';
import type { Json } from '../src/extract.js';
import type { SearchQuery } from '../src/types.js';
import { testConfig } from './helpers.js';

const query: SearchQuery = {
  checkIn: '2027-06-12',
  checkOut: '2027-06-19',
  nights: 7,
  occupancy: { adults: 3, childAges: [12] },
  currency: 'EUR',
};

describe('renderJson', () => {
  it('substitutes placeholders through a nested request body', () => {
    const body: Json = {
      stay: { arrival: '{checkIn}', departure: '{checkOut}' },
      guests: { adults: '{adults}', childAges: ['{childAges}'] },
      literal: 'no placeholders here',
    };
    expect(renderJson(body, query)).toEqual({
      stay: { arrival: '2027-06-12', departure: '2027-06-19' },
      // Count placeholders become numbers (engines reject "3" for adults);
      // an age list stays a string because it may hold several ages.
      guests: { adults: 3, childAges: ['12'] },
      literal: 'no placeholders here',
    });
  });
});

describe('quotesFromPayload', () => {
  const cfg = testConfig();
  const payload: Json = {
    offers: [
      { room: { name: 'Family sea view' }, price: { total: 2980, currency: 'EUR' }, book: '/b/1' },
      { room: { name: 'Standard park view' }, price: { total: 2410, currency: 'EUR' } },
      { room: { name: 'Broken' }, price: { total: 12, currency: 'EUR' } },
    ],
  };

  it('reads every offer when the paths are pinned', () => {
    const endpoint: EndpointConfig = {
      url: 'https://example.test',
      offersPath: 'offers[*]',
      pricePath: 'price.total',
      labelPath: 'room.name',
      currencyPath: 'price.currency',
      urlPath: 'book',
    };
    const quotes = quotesFromPayload(cfg, endpoint, payload, query);
    expect(quotes).toHaveLength(2); // the 12 EUR entry is below the sanity floor
    expect(quotes[0]).toMatchObject({
      label: 'Family sea view',
      total: 2980,
      currency: 'EUR',
      confidence: 'exact',
      url: '/b/1',
      nights: 7,
    });
  });

  it('falls back to the cheapest price-shaped number, flagged as heuristic', () => {
    const quotes = quotesFromPayload(cfg, { url: 'https://example.test' }, payload, query);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.total).toBe(2410);
    expect(quotes[0]?.confidence).toBe('heuristic');
    expect(quotes[0]?.label).toContain('offers[1].price.total');
  });

  it('returns nothing rather than guessing when the payload has no prices', () => {
    expect(quotesFromPayload(cfg, { url: 'https://x' }, { rooms: [] }, query)).toEqual([]);
  });
});

describe('pickCardTotal', () => {
  it('prefers the number on a line that says "total"', () => {
    const text = 'Family room\n€425 per night\nTotal for the stay: €2,980\nwas €3,400';
    expect(pickCardTotal(text, 150, 30_000)?.value).toBe(2980);
  });

  it('otherwise takes the largest plausible figure, ignoring per-night rates', () => {
    const text = 'Standard double\n€344 per night\n€2,410';
    expect(pickCardTotal(text, 150, 30_000)?.value).toBe(2410);
  });

  it('returns null when a card is sold out', () => {
    expect(pickCardTotal('Family room\nSold out', 150, 30_000)).toBeNull();
  });
});

describe('MockSource', () => {
  it('prices the whole party and moves between sweeps', async () => {
    const cfg = testConfig();
    const source = new MockSource(cfg);
    const first = await source.fetchQuotes(query);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((q) => q.total > 500)).toBe(true);

    source.bumpRound();
    const second = await source.fetchQuotes(query);
    expect(second.map((q) => q.total)).not.toEqual(first.map((q) => q.total));
  });

  it('charges more in peak August than in early June', async () => {
    const source = new MockSource(testConfig());
    const june = await source.fetchQuotes({ ...query, checkIn: '2027-06-02' });
    const august = await source.fetchQuotes({ ...query, checkIn: '2027-08-04' });
    expect(august[0]!.total).toBeGreaterThan(june[0]!.total);
  });
});
