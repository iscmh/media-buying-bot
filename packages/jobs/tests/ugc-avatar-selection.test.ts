/**
 * Phase 3g: friendlyHeyGenError mapping. The avatar-selection tests
 * (selectHeyGenAvatars plural) live in ugc-avatar-ranking.test.ts —
 * they need richer mocking for the Claude ranking call.
 */
import { describe, expect, it } from 'vitest';

import { friendlyHeyGenError } from '../src/functions/generate-ugc-variants';

describe('friendlyHeyGenError', () => {
  it('maps each error category to a user-facing message', () => {
    expect(friendlyHeyGenError('auth', 'whatever')).toMatch(/Reconnect HeyGen/i);
    expect(friendlyHeyGenError('credits', 'whatever')).toMatch(/Top up.*credits/i);
    expect(friendlyHeyGenError('avatar_missing', 'whatever')).toMatch(/avatar/i);
    expect(friendlyHeyGenError('timeout', 'whatever')).toMatch(/too long/i);
    expect(friendlyHeyGenError('server', 'whatever')).toMatch(/server-side/i);
    expect(friendlyHeyGenError('unknown', 'raw HeyGen error')).toBe('raw HeyGen error');
    expect(friendlyHeyGenError('unknown', undefined)).toMatch(/HeyGen submission failed/);
  });
});
