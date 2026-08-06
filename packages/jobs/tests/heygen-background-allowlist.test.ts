import { afterEach, describe, expect, it } from 'vitest';
import {
  heygenAllowNeutralBackgrounds,
  resolveHeygenBackgroundAllowlist,
} from '../src/functions/generate-polish26-heygen';

/**
 * Polish-26.0.7 Commit 61.7 tripwires. Two env-driven behaviors
 * that gate what the HeyGen avatar matcher will pick from — an
 * accidental drift here silently reintroduces neutral-background
 * (obviously-AI) avatars into the matcher pool and tanks video
 * quality on every generation without an error.
 */

describe('resolveHeygenBackgroundAllowlist', () => {
  const original = process.env['HEYGEN_BACKGROUND_ALLOWLIST'];
  afterEach(() => {
    if (original === undefined) {
      delete process.env['HEYGEN_BACKGROUND_ALLOWLIST'];
    } else {
      process.env['HEYGEN_BACKGROUND_ALLOWLIST'] = original;
    }
  });

  it("defaults to ['indoor_home', 'outdoor'] when env is unset", () => {
    delete process.env['HEYGEN_BACKGROUND_ALLOWLIST'];
    expect(resolveHeygenBackgroundAllowlist()).toEqual(['indoor_home', 'outdoor']);
  });

  it('parses a comma-separated env override', () => {
    process.env['HEYGEN_BACKGROUND_ALLOWLIST'] = 'indoor_home,outdoor,indoor_office';
    expect(resolveHeygenBackgroundAllowlist()).toEqual(['indoor_home', 'outdoor', 'indoor_office']);
  });

  it('lowercases + trims env entries', () => {
    process.env['HEYGEN_BACKGROUND_ALLOWLIST'] = '  INDOOR_HOME , Outdoor ';
    expect(resolveHeygenBackgroundAllowlist()).toEqual(['indoor_home', 'outdoor']);
  });

  it('falls back to the default on empty / whitespace-only env', () => {
    process.env['HEYGEN_BACKGROUND_ALLOWLIST'] = '';
    expect(resolveHeygenBackgroundAllowlist()).toEqual(['indoor_home', 'outdoor']);
    process.env['HEYGEN_BACKGROUND_ALLOWLIST'] = '   ';
    expect(resolveHeygenBackgroundAllowlist()).toEqual(['indoor_home', 'outdoor']);
    process.env['HEYGEN_BACKGROUND_ALLOWLIST'] = ' , , ';
    expect(resolveHeygenBackgroundAllowlist()).toEqual(['indoor_home', 'outdoor']);
  });
});

describe('heygenAllowNeutralBackgrounds', () => {
  const original = process.env['HEYGEN_ALLOW_NEUTRAL_BACKGROUNDS'];
  afterEach(() => {
    if (original === undefined) {
      delete process.env['HEYGEN_ALLOW_NEUTRAL_BACKGROUNDS'];
    } else {
      process.env['HEYGEN_ALLOW_NEUTRAL_BACKGROUNDS'] = original;
    }
  });

  it('defaults to false — neutral/studio backgrounds excluded by default', () => {
    // This is THE quality-gate default. Any drift here means every
    // subsequent HeyGen generation could pick a neutral-background
    // avatar and produce an obviously-AI-looking video.
    delete process.env['HEYGEN_ALLOW_NEUTRAL_BACKGROUNDS'];
    expect(heygenAllowNeutralBackgrounds()).toBe(false);
  });

  it("returns true on the documented opt-in strings ('true' / '1' / 'yes')", () => {
    for (const truthy of ['true', 'TRUE', 'True', '1', 'yes', 'YES', 'Yes']) {
      process.env['HEYGEN_ALLOW_NEUTRAL_BACKGROUNDS'] = truthy;
      expect(heygenAllowNeutralBackgrounds()).toBe(true);
    }
  });

  it("returns false on ambiguous strings ('maybe' / '0' / 'off' / empty)", () => {
    for (const falsy of ['', 'maybe', '0', 'off', 'no', 'false']) {
      process.env['HEYGEN_ALLOW_NEUTRAL_BACKGROUNDS'] = falsy;
      expect(heygenAllowNeutralBackgrounds()).toBe(false);
    }
  });
});
