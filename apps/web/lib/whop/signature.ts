import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Phase 8: Whop webhook signature verification.
 *
 * Whop signs webhook payloads with HMAC-SHA256 of the raw body, keyed
 * on the webhook secret you configure in the Whop dashboard. The
 * resulting hex digest comes in the `X-Whop-Signature` header.
 *
 * We use timingSafeEqual to avoid leaking byte positions through
 * comparison-time differences — overkill at our scale, free to do.
 *
 * If WHOP_WEBHOOK_SECRET isn't set, this returns false so every
 * incoming webhook is rejected — a dev-mode safety net.
 */
export function verifyWhopSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader) return false;
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (!secret) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  // Trim any "sha256=" prefix Whop might include — different webhook
  // providers vary. Accepts both raw hex and prefixed forms.
  const provided = signatureHeader
    .trim()
    .toLowerCase()
    .replace(/^sha256=/, '');

  if (expected.length !== provided.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  } catch {
    return false;
  }
}
