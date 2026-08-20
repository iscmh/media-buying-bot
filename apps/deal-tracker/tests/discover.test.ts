import { describe, expect, it } from 'vitest';
import { guessLabelPath, splitOfferPath } from '../src/discover.js';

describe('splitOfferPath', () => {
  it('turns a concrete offer index into a fan-out path', () => {
    expect(splitOfferPath('offers[3].price.total')).toEqual({
      offersPath: 'offers[*]',
      pricePath: 'price.total',
    });
  });

  it('handles nested arrays by splitting at the innermost index', () => {
    expect(splitOfferPath('data.hotels[0].rates[2].total')).toEqual({
      offersPath: 'data.hotels[0].rates[*]',
      pricePath: 'total',
    });
  });

  it('leaves a scalar path alone', () => {
    expect(splitOfferPath('cheapest.total')).toEqual({ pricePath: 'cheapest.total' });
  });
});

describe('guessLabelPath', () => {
  it('finds a room name one level down', () => {
    expect(guessLabelPath({ id: 7, roomType: { name: 'Family sea view' } })).toBe('roomType.name');
  });

  it('prefers a top-level name field', () => {
    expect(guessLabelPath({ title: 'Ultra All Inclusive', meta: { name: 'x' } })).toBe('title');
  });

  it('returns undefined when nothing looks like a label', () => {
    expect(guessLabelPath({ id: 1, price: 200 })).toBeUndefined();
  });
});
