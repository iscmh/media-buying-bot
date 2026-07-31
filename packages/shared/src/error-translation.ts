/**
 * Polish-15: translate raw generation-failure error strings into
 * operator-friendly UI copy.
 *
 * The worker layer surfaces failures with the verbatim provider error
 * (kie.ai PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED, etc.). Dumping
 * those directly is unfriendly and unactionable. This helper maps
 * the known patterns to a plain-English user message + a
 * suggestion + a retryable hint that the failed-generation card
 * uses to decide whether to show the retry CTA. The raw error
 * still gets shown under a "Technical details" expander for support.
 *
 * Pattern-based — order matters; more-specific patterns are checked
 * first. Unknown errors fall through to a generic message.
 */
export interface TranslatedGenerationError {
  /** One-sentence human-readable summary of what went wrong. */
  userMessage: string;
  /** One-sentence guidance on what the operator can try next. */
  suggestion: string;
  /** Whether the UI should show a "Retry" CTA. */
  retryable: boolean;
}

interface ErrorPattern {
  match: (raw: string) => boolean;
  translate: TranslatedGenerationError;
}

const PATTERNS: ReadonlyArray<ErrorPattern> = [
  // Content filters
  {
    match: (raw) => raw.includes('PROMINENT_PEOPLE_FILTER_FAILED'),
    translate: {
      userMessage:
        "Google's content filter flagged the generated character as resembling a public figure.",
      suggestion:
        'Try regenerating. Each attempt produces a different face. If it keeps happening on this source, the source character may be too distinctive.',
      retryable: true,
    },
  },
  {
    match: (raw) => raw.includes('AUDIO_FILTERED'),
    translate: {
      userMessage: "Google's audio filter flagged the dialogue content.",
      suggestion:
        'The source may have content patterns that trip safety filters. Try regenerating or use a different source.',
      retryable: true,
    },
  },
  {
    match: (raw) => raw.includes('PERSON_GENERATION_FAILED'),
    translate: {
      userMessage: "Google's person-generation filter blocked the render.",
      suggestion:
        'A regeneration with a fresh seed usually clears this. If it keeps tripping, try a different source character.',
      retryable: true,
    },
  },
  {
    match: (raw) => raw.includes('SAFETY_FILTER_FAILED'),
    translate: {
      userMessage: "Google's safety filter flagged the generated output.",
      suggestion: 'Retry the generation; safety triggers are usually stochastic.',
      retryable: true,
    },
  },
  // Balance / billing
  {
    match: (raw) => /insufficient\s+balance/i.test(raw),
    translate: {
      userMessage: 'Your kie.ai account ran out of credits mid-generation.',
      suggestion: 'Top up your kie.ai balance and retry. Visit kie.ai → Billing.',
      retryable: true,
    },
  },
  // Auth
  {
    match: (raw) =>
      /authentication\s+failed/i.test(raw) ||
      /invalid\s+API\s+key/i.test(raw) ||
      /\b401\b/.test(raw),
    translate: {
      userMessage: 'Authentication with a required service failed.',
      suggestion: 'Check your API keys on the Connections page.',
      retryable: false,
    },
  },
  // Rate limit
  {
    match: (raw) => /rate\s+limit/i.test(raw) || /\b429\b/.test(raw),
    translate: {
      userMessage: 'A provider rate limit was hit during generation.',
      suggestion: 'Wait a minute and retry.',
      retryable: true,
    },
  },
  // Transient backend hiccups
  {
    match: (raw) =>
      /Internal\s+Error/i.test(raw) ||
      /\bINTERNAL\b/.test(raw) ||
      /service\s+unavailable/i.test(raw) ||
      /deadline\s+exceeded/i.test(raw) ||
      /temporarily\s+unavailable/i.test(raw) ||
      /backend\s+error/i.test(raw),
    translate: {
      userMessage: 'Backend service hiccup during generation.',
      suggestion: 'Retry now. These usually clear on the next attempt.',
      retryable: true,
    },
  },
  // Validation
  {
    match: (raw) => /validation\s+failed/i.test(raw) || /\b422\b/.test(raw),
    translate: {
      userMessage: 'One of the providers rejected the request as malformed.',
      suggestion:
        'Check the Technical details below. If the issue is in the source script, re-uploading the source may help.',
      retryable: false,
    },
  },
  // Missing provider key
  {
    match: (raw) => /missing.*key/i.test(raw) || /not\s+connected/i.test(raw),
    translate: {
      userMessage: 'A required provider key is not connected.',
      suggestion: 'Visit the Connections page and add the missing key.',
      retryable: false,
    },
  },
];

export function translateGenerationError(
  rawError: string | null | undefined,
): TranslatedGenerationError {
  const raw = (rawError ?? '').trim();
  if (!raw) {
    return {
      userMessage: 'Generation failed without a recorded error.',
      suggestion: 'Try regenerating, or contact support if it keeps happening.',
      retryable: true,
    };
  }
  for (const pattern of PATTERNS) {
    if (pattern.match(raw)) return pattern.translate;
  }
  return {
    userMessage: 'Generation failed.',
    suggestion: 'Try regenerating, or contact support if it keeps happening.',
    retryable: true,
  };
}
