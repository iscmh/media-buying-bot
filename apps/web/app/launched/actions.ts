'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getDb, schema } from '@mbb/db';
import { inngest } from '@mbb/jobs';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Polish-25.6 Commit 34: web-based approval for kill/scale
 * recommendations. Replaces the Telegram tap-to-confirm flow that
 * shipped in Phase 5 (Telegram was deprecated for MVP; see the
 * Commit 34 note in `apps/web/app/settings/connections/page.tsx`).
 *
 * Mechanics — the same event bot's `approval-callback.ts` fires
 * when a Telegram user taps Confirm:
 *
 *   inngest.send('approval/decision.received', {
 *     approvalId, decision: 'confirm' | 'skip'
 *   })
 *
 * That's already the canonical dispatch point for
 * `handleApprovalDecision` in packages/jobs — no worker code is
 * touched, we're just adding a second producer of the same event.
 *
 * If the launched_ad has a kill_recommended_at OR scale_recommended_at
 * timestamp but NO open pending_approvals row (edge case: the polling
 * cron marked the recommendation but for some reason didn't insert
 * the approval row), we create one ourselves — mirrors what the
 * admin test-actions server action does.
 */

export interface ApprovalActionResult {
  ok: boolean;
  message: string;
}

async function requireCurrentUserId(): Promise<string> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  return user.id;
}

interface DispatchInput {
  launchedAdId: string;
  action: 'kill' | 'scale';
  decision: 'confirm' | 'skip';
}

async function dispatchApproval({
  launchedAdId,
  action,
  decision,
}: DispatchInput): Promise<ApprovalActionResult> {
  const userId = await requireCurrentUserId();
  const db = getDb();

  const ad = await db.query.launchedAds.findFirst({
    where: and(eq(schema.launchedAds.id, launchedAdId), eq(schema.launchedAds.userId, userId)),
    columns: {
      id: true,
      userId: true,
      dailyBudgetUsd: true,
      killRecommendedAt: true,
      scaleRecommendedAt: true,
      scaleRecommendedToUsd: true,
      metaAdSetId: true,
    },
  });
  if (!ad) return { ok: false, message: 'Ad not found. Refresh and try again.' };

  if (action === 'kill' && !ad.killRecommendedAt) {
    return { ok: false, message: 'No open kill recommendation for this ad.' };
  }
  if (action === 'scale' && !ad.scaleRecommendedAt) {
    return { ok: false, message: 'No open scale recommendation for this ad.' };
  }
  if (action === 'scale' && !ad.metaAdSetId) {
    return {
      ok: false,
      message: "Ad has no meta_ad_set_id. Meta didn't return one at launch. Can't scale.",
    };
  }

  // Find (or create) the pending_approvals row. Prefer an existing open
  // row so we don't double-fire the Inngest handler for the same
  // recommendation. If none exists we create one — same pattern the
  // admin test-actions surface uses.
  const existing = await db.query.pendingApprovals.findFirst({
    where: and(
      eq(schema.pendingApprovals.launchedAdId, ad.id),
      eq(schema.pendingApprovals.actionType, action),
      eq(schema.pendingApprovals.status, 'pending'),
    ),
    columns: { id: true },
  });

  let approvalId: string;
  if (existing) {
    approvalId = existing.id;
  } else {
    const [inserted] = await db
      .insert(schema.pendingApprovals)
      .values({
        userId: ad.userId,
        launchedAdId: ad.id,
        actionType: action,
        proposedPayload:
          action === 'scale'
            ? {
                new_budget_usd: Number(ad.scaleRecommendedToUsd ?? ad.dailyBudgetUsd),
                from_budget_usd: Number(ad.dailyBudgetUsd),
              }
            : {},
        reason: 'Web-based approval from /launched',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .returning({ id: schema.pendingApprovals.id });
    if (!inserted) return { ok: false, message: 'Could not create approval row.' };
    approvalId = inserted.id;
  }

  await inngest.send({
    name: 'approval/decision.received',
    data: { approvalId, decision },
  });

  revalidatePath('/launched');
  revalidatePath('/dashboard');

  const verb = decision === 'confirm' ? 'approved' : 'skipped';
  return {
    ok: true,
    message: `${action === 'kill' ? 'Kill' : 'Scale'} ${verb}. Meta call runs in the background. Refresh in a few seconds to see the status change.`,
  };
}

export async function approveKillAction(launchedAdId: string): Promise<ApprovalActionResult> {
  return dispatchApproval({ launchedAdId, action: 'kill', decision: 'confirm' });
}

export async function skipKillAction(launchedAdId: string): Promise<ApprovalActionResult> {
  return dispatchApproval({ launchedAdId, action: 'kill', decision: 'skip' });
}

export async function approveScaleAction(launchedAdId: string): Promise<ApprovalActionResult> {
  return dispatchApproval({ launchedAdId, action: 'scale', decision: 'confirm' });
}

export async function skipScaleAction(launchedAdId: string): Promise<ApprovalActionResult> {
  return dispatchApproval({ launchedAdId, action: 'scale', decision: 'skip' });
}
