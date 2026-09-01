/**
 * AI analyst layer: Claude reviews each flagged value bet for qualitative
 * risk the odds math can't see (injury news, motivation spots, weather,
 * lineup uncertainty) and returns a verdict. Requires ANTHROPIC_API_KEY.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AiReview, ValueBet } from '../types.js';

const SYSTEM = `You are a sharp, skeptical sports betting risk analyst.
You review bets that a quantitative scanner has flagged as +EV against the
de-vigged sharp-book consensus. Your job is NOT to predict winners — it is to
catch reasons the market number might be stale or the edge illusory:
injuries, rest/travel spots, weather, lineup or pitching uncertainty,
lookahead/letdown spots, or a line that moved for information reasons.

Respond with STRICT JSON only, no prose, matching:
{"verdict":"bet"|"caution"|"pass","confidence":"low"|"medium"|"high","reasoning":"<2-3 sentences>","riskFlags":["..."]}

Be conservative: if you know nothing game-specific beyond the numbers, say so
in reasoning, keep confidence "low", and default to "caution" rather than
inventing facts. Never fabricate injury or lineup news.`;

function describeBet(bet: ValueBet): string {
  const pointStr = bet.point !== undefined ? ` (line ${bet.point})` : '';
  return [
    `Game: ${bet.game.awayTeam} @ ${bet.game.homeTeam} (${bet.game.sportTitle})`,
    `Start: ${bet.game.commenceTime}`,
    `Market: ${bet.market} — outcome: ${bet.outcome}${pointStr}`,
    `Best price: ${bet.bestDecimal.toFixed(3)} decimal at ${bet.bestBook}`,
    `Consensus fair probability: ${(bet.fairProb * 100).toFixed(1)}% across ${bet.bookCount} books`,
    `Model EV at best price: ${(bet.ev * 100).toFixed(1)}%`,
  ].join('\n');
}

function parseReview(text: string): AiReview {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON in AI response');
  const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<AiReview>;
  const verdicts = ['bet', 'caution', 'pass'] as const;
  const confidences = ['low', 'medium', 'high'] as const;
  return {
    verdict: verdicts.includes(parsed.verdict as (typeof verdicts)[number])
      ? (parsed.verdict as AiReview['verdict'])
      : 'caution',
    confidence: confidences.includes(parsed.confidence as (typeof confidences)[number])
      ? (parsed.confidence as AiReview['confidence'])
      : 'low',
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    riskFlags: Array.isArray(parsed.riskFlags)
      ? parsed.riskFlags.filter((f): f is string => typeof f === 'string')
      : [],
  };
}

export async function reviewBets(
  bets: ValueBet[],
  options: { model?: string; extraContext?: string } = {},
): Promise<void> {
  if (bets.length === 0) return;
  const client = new Anthropic();
  const model = options.model ?? 'claude-opus-5';

  for (const bet of bets) {
    const context = options.extraContext
      ? `\n\nAdditional context supplied by the user (news, injuries):\n${options.extraContext}`
      : '';
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Review this flagged bet:\n\n${describeBet(bet)}${context}`,
          },
        ],
      });
      if (response.stop_reason === 'refusal') {
        bet.aiReview = {
          verdict: 'caution',
          confidence: 'low',
          reasoning: 'AI review declined this request.',
          riskFlags: [],
        };
        continue;
      }
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      bet.aiReview = parseReview(text);
    } catch (error) {
      bet.aiReview = {
        verdict: 'caution',
        confidence: 'low',
        reasoning: `AI review unavailable: ${error instanceof Error ? error.message : String(error)}`,
        riskFlags: [],
      };
    }
  }
}
