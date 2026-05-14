import { randomBytes } from 'node:crypto';
import { desc, eq, isNull, sql } from 'drizzle-orm';
import { INVITE_CODE_DEFAULT_TTL_DAYS, INVITE_CODE_LENGTH } from '@mbb/shared';
import { getDb } from './client';
import { inviteCodes, waitlistEntries } from './schema/beta-access';

/**
 * Phase 7 beta-access helpers. The signup-side redemption is handled
 * by the auth.users INSERT trigger (atomic with user creation). These
 * helpers cover:
 *
 *   - validateInviteCode: read-only lookup the signup form runs before
 *     calling supabase.auth.signUp, so we can surface a clear "this
 *     code is bad" error instead of the trigger's bare exception.
 *   - createInviteCode: admin generates a fresh code from
 *     /admin/invites or as part of waitlist approval.
 *   - revokeInviteCode: admin clicks Revoke — flips revoked_at.
 *   - joinWaitlist: public-insert path from /waitlist.
 *   - approveWaitlistEntry: admin clicks Approve — creates a code +
 *     stamps the row + returns the code so the caller can email it.
 *
 * Codes are uppercase alphanumeric, length 8 by default — high enough
 * entropy for a beta (8 chars from 32 alphabet = ~10¹² combos) but
 * still tappable on phones.
 */

export type InviteCodeValidationResult =
  | { ok: true; inviteCodeId: string }
  | {
      ok: false;
      reason: 'not_found' | 'revoked' | 'expired' | 'fully_used';
    };

/**
 * Lightweight pre-signup check. The auth trigger re-validates with
 * FOR UPDATE — race-safe — but doing this client-callable check
 * up-front means a typo'd code shows an inline error instead of
 * "signup failed" once Supabase Auth has already created the user.
 */
export async function validateInviteCode(code: string): Promise<InviteCodeValidationResult> {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return { ok: false, reason: 'not_found' };
  const db = getDb();
  const row = await db.query.inviteCodes.findFirst({
    where: eq(inviteCodes.code, trimmed),
    columns: {
      id: true,
      revokedAt: true,
      expiresAt: true,
      useCount: true,
      maxUses: true,
    },
  });
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revokedAt) return { ok: false, reason: 'revoked' };
  if (row.expiresAt <= new Date()) return { ok: false, reason: 'expired' };
  if (row.useCount >= row.maxUses) return { ok: false, reason: 'fully_used' };
  return { ok: true, inviteCodeId: row.id };
}

export interface CreateInviteCodeInput {
  createdBy: string;
  isMultiUse?: boolean;
  maxUses?: number;
  ttlDays?: number;
  metadata?: Record<string, unknown>;
}

export interface CreateInviteCodeResult {
  id: string;
  code: string;
  expiresAt: Date;
}

export async function createInviteCode(
  input: CreateInviteCodeInput,
): Promise<CreateInviteCodeResult> {
  const db = getDb();
  const maxUses = input.maxUses ?? (input.isMultiUse ? 50 : 1);
  const ttlDays = input.ttlDays ?? INVITE_CODE_DEFAULT_TTL_DAYS;
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  // Retry on the (rare) unique-code collision. 8-char uppercase
  // alphanumeric has ~30^8 ≈ 6.5e11 combos — collisions are unicorns
  // but we'd rather throw on the 5th try than infinite-loop.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCodeString();
    try {
      const [row] = await db
        .insert(inviteCodes)
        .values({
          code,
          createdBy: input.createdBy,
          isMultiUse: !!input.isMultiUse,
          maxUses,
          expiresAt,
          metadata: input.metadata ?? {},
        })
        .returning({
          id: inviteCodes.id,
          code: inviteCodes.code,
          expiresAt: inviteCodes.expiresAt,
        });
      return { id: row!.id, code: row!.code, expiresAt: row!.expiresAt };
    } catch (err) {
      // postgres-js unique-violation has code 23505. Drizzle wraps it
      // as DrizzleQueryError — easiest cross-driver check is on message.
      if (err instanceof Error && /duplicate key|unique/i.test(err.message)) {
        continue;
      }
      throw err;
    }
  }
  throw new Error('createInviteCode: failed to generate a unique code after 5 attempts');
}

export async function revokeInviteCode(id: string): Promise<void> {
  const db = getDb();
  await db.update(inviteCodes).set({ revokedAt: new Date() }).where(eq(inviteCodes.id, id));
}

export async function listInviteCodes(): Promise<
  Array<{
    id: string;
    code: string;
    createdBy: string | null;
    isMultiUse: boolean;
    maxUses: number;
    useCount: number;
    expiresAt: Date;
    revokedAt: Date | null;
    createdAt: Date;
  }>
> {
  const db = getDb();
  return db.query.inviteCodes.findMany({
    orderBy: desc(inviteCodes.createdAt),
  });
}

// =========================================================================
// Waitlist
// =========================================================================

export type JoinWaitlistResult =
  | { ok: true; entryId: string }
  | { ok: false; reason: 'duplicate' | 'invalid_email' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function joinWaitlist(input: {
  email: string;
  name?: string;
  source?: string;
  message?: string;
}): Promise<JoinWaitlistResult> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, reason: 'invalid_email' };
  const db = getDb();
  try {
    const [row] = await db
      .insert(waitlistEntries)
      .values({
        email,
        name: input.name?.trim() || null,
        source: input.source?.trim() || null,
        message: input.message?.trim() || null,
      })
      .returning({ id: waitlistEntries.id });
    return { ok: true, entryId: row!.id };
  } catch (err) {
    if (err instanceof Error && /duplicate key|unique/i.test(err.message)) {
      return { ok: false, reason: 'duplicate' };
    }
    throw err;
  }
}

export async function listWaitlistEntries(opts?: { onlyUnapproved?: boolean }): Promise<
  Array<{
    id: string;
    email: string;
    name: string | null;
    source: string | null;
    message: string | null;
    approvedAt: Date | null;
    approvedBy: string | null;
    inviteCodeId: string | null;
    createdAt: Date;
  }>
> {
  const db = getDb();
  return db.query.waitlistEntries.findMany({
    where: opts?.onlyUnapproved ? isNull(waitlistEntries.approvedAt) : undefined,
    orderBy: opts?.onlyUnapproved ? waitlistEntries.createdAt : desc(waitlistEntries.createdAt),
  });
}

export interface ApproveWaitlistEntryResult {
  ok: boolean;
  inviteCode?: { id: string; code: string; expiresAt: Date };
  email?: string;
  errorMessage?: string;
}

export async function approveWaitlistEntry(input: {
  entryId: string;
  approvedBy: string;
}): Promise<ApproveWaitlistEntryResult> {
  const db = getDb();
  const entry = await db.query.waitlistEntries.findFirst({
    where: eq(waitlistEntries.id, input.entryId),
  });
  if (!entry) return { ok: false, errorMessage: 'Waitlist entry not found.' };
  if (entry.approvedAt) {
    return { ok: false, errorMessage: 'Already approved.' };
  }
  const inviteCode = await createInviteCode({
    createdBy: input.approvedBy,
    metadata: { source: 'waitlist_approval', waitlist_entry_id: input.entryId },
  });
  await db
    .update(waitlistEntries)
    .set({
      approvedAt: new Date(),
      approvedBy: input.approvedBy,
      inviteCodeId: inviteCode.id,
    })
    .where(eq(waitlistEntries.id, input.entryId));
  return { ok: true, inviteCode, email: entry.email };
}

// =========================================================================
// Founding member — read-side
// =========================================================================

/**
 * Returns how many users currently carry is_founding_member = true.
 * The admin /admin/invites footer shows this so the operator knows
 * how much room is left before the cap closes.
 */
export async function countFoundingMembers(): Promise<number> {
  const db = getDb();
  const [row] = await db.execute(
    sql<{ count: string }>`select count(*)::text as count
                            from public.user_settings
                            where is_founding_member = true`,
  );
  // postgres-js returns rows directly; pg returns { rows }. Normalize.
  const list = Array.isArray(row) ? row : ((row as { rows?: unknown[] }).rows ?? [row]);
  const first = (list as Array<{ count?: string }>)[0];
  return Number(first?.count ?? 0);
}

// =========================================================================
// Helpers
// =========================================================================

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ambiguity-trimmed

function generateCodeString(): string {
  const bytes = randomBytes(INVITE_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}
