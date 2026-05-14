import 'server-only';

/**
 * Phase 7: minimal Resend-or-stub email sender. Used (today) only by
 * the admin waitlist-approval flow to send an invite code.
 *
 * Behavior:
 *   - If RESEND_API_KEY + RESEND_FROM_EMAIL are set, POST to
 *     api.resend.com/emails. Best-effort — failures are logged + the
 *     caller decides whether to surface them.
 *   - If either env var is missing, log the would-have-been email
 *     payload to stdout and return ok=true (stub mode). Lets dev
 *     happen end-to-end without a Resend account.
 */

export interface SendEmailInput {
  to: string;
  subject: string;
  /** Plain-text body. We don't ship HTML templates yet. */
  text: string;
}

export interface SendEmailResult {
  ok: boolean;
  stubbed: boolean;
  status?: number;
  errorMessage?: string;
  /** Resend-assigned message id on success. */
  messageId?: string;
}

const RESEND_BASE = 'https://api.resend.com';

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;

  if (!apiKey || !from) {
    // Dev / preview path. Log the payload so the operator can read
    // the would-have-been-sent email out of `pnpm dev` output.
    console.info('[email:stub]', {
      to: input.to,
      subject: input.subject,
      preview: input.text.slice(0, 160),
    });
    return { ok: true, stubbed: true };
  }

  try {
    const res = await fetch(`${RESEND_BASE}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    const json = (await res.json().catch(() => null)) as {
      id?: string;
      message?: string;
    } | null;
    if (!res.ok) {
      return {
        ok: false,
        stubbed: false,
        status: res.status,
        errorMessage: json?.message ?? `Resend returned HTTP ${res.status}`,
      };
    }
    return { ok: true, stubbed: false, status: res.status, messageId: json?.id };
  } catch (err) {
    return {
      ok: false,
      stubbed: false,
      status: 0,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
