import { logMetaApiCall } from '@mbb/db';
import { callMeta } from './client';
import { effectiveLaunchMode, type LaunchMode } from './launch';

/**
 * Phase 5: lifecycle helpers — pause an ad or scale an ad set's daily
 * budget. Both gate on the same mode + BOT_DRY_RUN matrix as the
 * Phase-4b create helpers; both go through callMeta so audit log +
 * spend-safety + rate-limit fall out for free.
 *
 * Callers (the approval-confirmed Inngest job) are responsible for
 * re-checking caps BEFORE invoking — these helpers will happily ship
 * whatever budget you pass to scaleAdBudget. Defense in depth: the
 * server-side cap math lives in evaluatePerformance + the launch cap
 * helpers.
 */

export interface PauseAdInput {
  userId: string;
  accessToken: string;
  adId: string;
  mode: LaunchMode;
}

export interface LifecycleResult {
  ok: boolean;
  dryRun: boolean;
  errorMessage?: string;
  metaErrorCode?: number;
}

export async function pauseAd(input: PauseAdInput): Promise<LifecycleResult> {
  const effective = effectiveLaunchMode(input.mode);
  const t0 = Date.now();
  const endpoint = `/${input.adId}`;
  const body = { status: 'PAUSED' };

  if (effective === 'mock') {
    await logMetaApiCall({
      userId: input.userId,
      endpoint,
      method: 'POST',
      requestBody: body,
      responseStatus: 0,
      responseBody: {
        _dry_run: true,
        _caller_mode: input.mode,
        _env_override: input.mode === 'live',
        action: 'pause',
      },
      latencyMs: Date.now() - t0,
      dryRun: true,
    });
    return { ok: true, dryRun: true };
  }

  return invokeLifecycleCall({
    userId: input.userId,
    accessToken: input.accessToken,
    endpoint,
    body,
  });
}

export interface ScaleAdBudgetInput {
  userId: string;
  accessToken: string;
  adSetId: string;
  newDailyBudgetUsd: number;
  mode: LaunchMode;
}

export async function scaleAdBudget(input: ScaleAdBudgetInput): Promise<LifecycleResult> {
  const effective = effectiveLaunchMode(input.mode);
  const t0 = Date.now();
  const endpoint = `/${input.adSetId}`;
  // Meta wants daily_budget in minor units (cents for USD).
  const body = { daily_budget: Math.round(input.newDailyBudgetUsd * 100) };

  if (effective === 'mock') {
    await logMetaApiCall({
      userId: input.userId,
      endpoint,
      method: 'POST',
      requestBody: body,
      responseStatus: 0,
      responseBody: {
        _dry_run: true,
        _caller_mode: input.mode,
        _env_override: input.mode === 'live',
        action: 'scale',
        new_daily_budget_usd: input.newDailyBudgetUsd,
      },
      latencyMs: Date.now() - t0,
      dryRun: true,
    });
    return { ok: true, dryRun: true };
  }

  return invokeLifecycleCall({
    userId: input.userId,
    accessToken: input.accessToken,
    endpoint,
    body,
  });
}

async function invokeLifecycleCall(input: {
  userId: string;
  accessToken: string;
  endpoint: string;
  body: Record<string, unknown>;
}): Promise<LifecycleResult> {
  try {
    const result = await callMeta({
      userId: input.userId,
      endpoint: input.endpoint,
      method: 'POST',
      body: input.body,
      accessToken: input.accessToken,
    });
    if (result.status >= 200 && result.status < 300) {
      return { ok: true, dryRun: false };
    }
    const { message, code } = extractMetaError(result.body);
    return {
      ok: false,
      dryRun: false,
      errorMessage: message ?? `Meta returned HTTP ${result.status}`,
      metaErrorCode: code,
    };
  } catch (err) {
    return {
      ok: false,
      dryRun: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

function extractMetaError(body: unknown): { message?: string; code?: number } {
  if (!body || typeof body !== 'object') return {};
  const error = (body as { error?: { message?: string; code?: number } }).error;
  if (!error) return {};
  return { message: error.message, code: error.code };
}
