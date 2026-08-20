import { describe, expect, it } from 'vitest';
import { chunkText, parseCommand } from '../src/telegram.js';
import { formatAlert, formatDealList, formatMoney, escapeHtml } from '../src/format.js';
import { quote, testConfig } from './helpers.js';

describe('parseCommand', () => {
  it('parses a bare command', () => {
    expect(parseCommand('/status')).toEqual({ command: 'status', args: [] });
  });

  it('strips the @botname suffix groups add', () => {
    expect(parseCommand('/target@reina_deal_bot 3200')).toEqual({
      command: 'target',
      args: ['3200'],
    });
  });

  it('ignores ordinary chat', () => {
    expect(parseCommand('hello')).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
  });
});

describe('chunkText', () => {
  it('leaves a short message alone', () => {
    expect(chunkText('hi', 100)).toEqual(['hi']);
  });

  it('splits on line boundaries under Telegram’s cap', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join('\n')).toBe(text);
  });
});

describe('formatting', () => {
  const cfg = testConfig();

  it('renders an alert with the party, dates and per-person maths', () => {
    const text = formatAlert(cfg, {
      reason: 'new_low',
      quote: quote({ total: 2800 }),
      previousTotal: 3000,
      previousBest: 3000,
      changePct: -6.67,
      pppn: 100,
    });
    expect(text).toContain('New lowest price');
    expect(text).toContain('Sat 12 Jun 2027');
    expect(text).toContain('3 adults + 1 child (12)');
    expect(text).toContain('per person / night');
    expect(text).toContain('-6.7%');
  });

  it('warns when the price was read heuristically', () => {
    const text = formatAlert(cfg, {
      reason: 'price_drop',
      quote: quote({ confidence: 'heuristic' }),
      pppn: 100,
    });
    expect(text).toContain('verify on the site');
  });

  it('escapes HTML so a room name cannot break the message', () => {
    expect(escapeHtml('Suite <b>x</b> & co')).toBe('Suite &lt;b&gt;x&lt;/b&gt; &amp; co');
  });

  it('formats an empty leaderboard without pretending it has data', () => {
    expect(formatDealList([], 'Best')).toContain('Nothing tracked yet');
  });

  it('formats money in the quoted currency', () => {
    expect(formatMoney(2980, 'EUR')).toContain('2,980');
  });
});
