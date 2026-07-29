import { describe, expect, it } from 'vitest';
import { _scrubStringForTests, _scrubValueForTests, redactSentryEvent } from '../sentry-redact';

/**
 * Polish-25.7 Commit 44: pin the redaction behavior so a future edit
 * that loosens the regexes or the sensitive-key list is caught in CI
 * before it lets a real credential onto Sentry.
 */

describe('scrubString: credential regex coverage', () => {
  it('redacts Anthropic keys', () => {
    const out = _scrubStringForTests('sk-ant-abcdefghijklmnopqrstuvwx1234567890 leaked');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-ant-abcdefghij');
  });

  it('redacts OpenAI keys', () => {
    const out = _scrubStringForTests('OpenAI sk-abcdefghijklmnopqrstuvwx12345678 failed');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts Google API keys', () => {
    const out = _scrubStringForTests('AIzaSy0123456789abcdefghijklmnopqrstuvwx booms');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts Meta long-lived tokens', () => {
    const out = _scrubStringForTests('EAA' + 'A'.repeat(60) + ' failed with subcode 460');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts Bearer tokens in Authorization strings', () => {
    const out = _scrubStringForTests('Authorization: Bearer abc.def.ghi.jkl-mno.pqr-stu.vwx-yz1');
    expect(out).toContain('[REDACTED]');
  });

  it('leaves benign strings intact', () => {
    const out = _scrubStringForTests('user 1ccebde7-5e2b-4d5a-9da7-28707a696645 is paused');
    expect(out).toBe('user 1ccebde7-5e2b-4d5a-9da7-28707a696645 is paused');
  });
});

describe('scrubValue: sensitive key allowlist', () => {
  it('wipes obvious key names regardless of value shape', () => {
    const out = _scrubValueForTests({
      access_token: 'literally-anything',
      accessToken: 'literally-anything',
      apiKey: 'sk-ant-...',
      encryptedFoo: '...',
      password: 'plaintext',
      normal: 'keep-me',
    }) as Record<string, unknown>;
    expect(out.access_token).toBe('[REDACTED]');
    expect(out.accessToken).toBe('[REDACTED]');
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.encryptedFoo).toBe('[REDACTED]');
    expect(out.password).toBe('[REDACTED]');
    expect(out.normal).toBe('keep-me');
  });

  it('recurses into nested objects and arrays', () => {
    const out = _scrubValueForTests({
      user: { id: '123', credentials: { token: 'x'.repeat(40) } },
      logs: [{ message: 'sk-ant-' + 'y'.repeat(25) }],
    }) as {
      user: { id: string; credentials: { token: string } };
      logs: [{ message: string }];
    };
    // `token` inside a nested non-sensitive parent gets redacted by key name.
    expect(out.user.credentials.token).toBe('[REDACTED]');
    // Regex catches the raw sk-ant- inside an array item's string field.
    expect(out.logs[0]!.message).toContain('[REDACTED]');
    // Non-sensitive scalar carries through untouched.
    expect(out.user.id).toBe('123');
  });
});

describe('redactSentryEvent: full event flow', () => {
  it('redacts the exception value + breadcrumb data + request payload', () => {
    const event = redactSentryEvent({
      message: 'sk-ant-' + 'a'.repeat(30) + ' failed',
      exception: {
        values: [{ type: 'Error', value: 'thrown with sk-' + 'b'.repeat(30) + ' inside' }],
      },
      breadcrumbs: [
        {
          message: 'Fetched with Bearer ' + 'c'.repeat(40),
          data: { access_token: 'raw', unrelated: 'ok' },
        },
      ],
      request: {
        url: 'https://example.com/callback?token=' + 'd'.repeat(40),
        data: { api_key: 'raw', body: { headline: 'safe' } },
      },
    });
    expect(event.message).toContain('[REDACTED]');
    expect(event.exception!.values![0]!.value).toContain('[REDACTED]');
    expect(event.breadcrumbs![0]!.message).toContain('[REDACTED]');
    const bd = event.breadcrumbs![0]!.data as { access_token: string; unrelated: string };
    expect(bd.access_token).toBe('[REDACTED]');
    expect(bd.unrelated).toBe('ok');
    const rd = event.request!.data as { api_key: string; body: { headline: string } };
    expect(rd.api_key).toBe('[REDACTED]');
    expect(rd.body.headline).toBe('safe');
  });
});
