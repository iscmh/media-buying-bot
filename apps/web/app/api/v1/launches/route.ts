import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  OfferUrlSchema,
  PLATFORM_HARD_AD_DAILY_BUDGET_USD,
  checkBudgetMeetsMetaMinimum,
} from '@mbb/shared';
import {
  assertDailyLaunchBudgetCap,
  assertFirstLiveLaunchCap,
  getDb,
  logAuditEvent,
  schema,
} from '@mbb/db';
import { apiError, apiOk } from '@/lib/api-envelope';
import { parseJsonBody, withApi } from '@/lib/api-auth';
import { sendMetaLaunchEvent } from '@/lib/inngest/send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateLaunchBody = z.object({
  generation_id: z.string().uuid(),
  mode: z.enum(['mock', 'live']).default('live'),
  page_id: z.string().optional(),
  offer_url: z.string().optional(),
  targeting_countries: z.array(z.string()).optional(),
  age_min: z.number().int().min(13).max(65).optional(),
  age_max: z.number().int().min(13).max(65).optional(),
  per_ad_budget_usd: z.number().positive().optional(),
});

/**
 * Polish-25.10 Commit 59: POST /api/v1/launches
 *
 * Mirrors launchApprovedActionImpl. Same safety layer, same
 * validation, same Inngest dispatch — the worker does the real work.
 */
export const POST = withApi('launches.create', async (req, ctx) => {
  const parsed = await parseJsonBody(req, CreateLaunchBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const db = getDb();
  const job = await db.query.generationJobs.findFirst({
    where: and(
      eq(schema.generationJobs.id, body.generation_id),
      eq(schema.generationJobs.userId, ctx.userId),
    ),
    columns: { id: true },
  });
  if (!job) return apiError('not_found', 'Generation not found.');

  const settings = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, ctx.userId),
    columns: {
      launchAcknowledgedAt: true,
      liveLaunchAcknowledgedAt: true,
      defaultAdDailyBudgetUsd: true,
    },
  });
  if (!settings) return apiError('forbidden', 'User settings missing.');
  if (!settings.launchAcknowledgedAt) {
    return apiError(
      'forbidden',
      'Launch acknowledgment required. Visit /runs/<id> in the web UI once to complete the confirmation dialog.',
    );
  }
  if (body.mode === 'live' && !settings.liveLaunchAcknowledgedAt) {
    return apiError(
      'forbidden',
      'Live-launch acknowledgment required. Visit /runs/<id> in the web UI once to complete the triple-confirm dialog.',
    );
  }
  if (body.mode === 'live' && !body.page_id) {
    return apiError('validation_error', 'page_id is required for live launches.');
  }
  if (body.mode === 'live') {
    const urlCheck = OfferUrlSchema.safeParse(body.offer_url ?? '');
    if (!urlCheck.success) {
      return apiError(
        'validation_error',
        `Invalid offer_url: ${urlCheck.error.issues[0]?.message ?? 'malformed'}`,
      );
    }
  }

  if (body.mode === 'live' && body.page_id) {
    const conn = await db.query.metaConnections.findFirst({
      where: and(
        eq(schema.metaConnections.userId, ctx.userId),
        eq(schema.metaConnections.status, 'active'),
      ),
      columns: { pages: true, accountCurrency: true, minDailyBudgetMinor: true },
    });
    const pages = (conn?.pages ?? []) as Array<{ id: string; tasks?: string[] }>;
    if (pages.length === 0) {
      return apiError('forbidden', 'No Facebook Pages on your Meta connection. Reconnect Meta.');
    }
    const match = pages.find((p) => p.id === body.page_id);
    if (!match) {
      return apiError(
        'validation_error',
        `page_id ${body.page_id} is not on your Meta connection.`,
      );
    }
    if (match.tasks && !match.tasks.includes('CREATE_CONTENT')) {
      return apiError(
        'forbidden',
        "You don't have CREATE_CONTENT permission on this Page in Meta.",
      );
    }
    if (conn?.accountCurrency) {
      const rawBudget = body.per_ad_budget_usd ?? Number(settings.defaultAdDailyBudgetUsd);
      const perAd = Math.min(rawBudget, PLATFORM_HARD_AD_DAILY_BUDGET_USD);
      const budgetCheck = checkBudgetMeetsMetaMinimum({
        usdAmount: perAd,
        currency: conn.accountCurrency,
        connectionMin: conn.minDailyBudgetMinor ?? null,
      });
      if (!budgetCheck.ok) {
        return apiError('validation_error', budgetCheck.reason);
      }
    }
  }

  const approved = await db.query.generatedCreatives.findMany({
    where: and(
      eq(schema.generatedCreatives.generationJobId, body.generation_id),
      eq(schema.generatedCreatives.userId, ctx.userId),
      eq(schema.generatedCreatives.status, 'approved'),
    ),
    columns: { id: true },
  });
  if (approved.length === 0) {
    return apiError('conflict', 'No approved variants on this generation to launch.');
  }

  const rawBudget = body.per_ad_budget_usd ?? Number(settings.defaultAdDailyBudgetUsd);
  const perAdBudget = Math.min(rawBudget, PLATFORM_HARD_AD_DAILY_BUDGET_USD);
  const plannedBudgetUsd = approved.length * perAdBudget;

  if (body.mode === 'live') {
    const firstCap = await assertFirstLiveLaunchCap(ctx.userId, plannedBudgetUsd);
    if (!firstCap.allowed) {
      return apiError('forbidden', firstCap.reason, {
        details: { planned_budget_usd: plannedBudgetUsd },
      });
    }
  }
  const cap = await assertDailyLaunchBudgetCap(ctx.userId, plannedBudgetUsd);
  if (!cap.allowed) {
    return apiError('forbidden', cap.reason, {
      details: {
        planned_budget_usd: plannedBudgetUsd,
        committed_today_usd: cap.committedTodayUsd,
        cap_usd: cap.capUsd,
      },
    });
  }

  await logAuditEvent({
    userId: ctx.userId,
    eventType: 'ad_launch_requested',
    eventData: {
      job_id: body.generation_id,
      approved_count: approved.length,
      planned_budget_usd: plannedBudgetUsd,
      mode: body.mode,
      via: 'api_v1',
      api_key_id: ctx.apiKeyId,
    },
  });
  await sendMetaLaunchEvent({
    userId: ctx.userId,
    generationJobId: body.generation_id,
    mode: body.mode,
    ...(body.page_id ? { pageId: body.page_id } : {}),
    ...(body.offer_url ? { offerUrl: body.offer_url } : {}),
    ...(body.targeting_countries ? { targetingCountries: body.targeting_countries } : {}),
    ...(body.age_min != null ? { ageMin: body.age_min } : {}),
    ...(body.age_max != null ? { ageMax: body.age_max } : {}),
    perAdBudgetUsd: perAdBudget,
  });

  return apiOk(
    {
      generation_id: body.generation_id,
      approved_count: approved.length,
      planned_budget_usd: plannedBudgetUsd,
      per_ad_budget_usd: perAdBudget,
      committed_today_usd: cap.committedTodayUsd,
      cap_usd: cap.capUsd,
      mode: body.mode,
      status: 'queued',
    },
    { status: 202 },
  );
});
