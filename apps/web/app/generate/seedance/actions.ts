'use server';

import { redirect } from 'next/navigation';
import { getCreditBalance, getDb, schema } from '@mbb/db';
import { getModelCostPreview } from '@mbb/shared';
import { inngest } from '@mbb/jobs';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Polish-29.0.7 Commit 116: user-facing Quick Seedance action.
 *
 * The admin `/admin/test-actions` button proved the plumbing;
 * this is the same event surface exposed to normal paying users.
 *
 * Flow:
 *   1. Auth check (any signed-in user).
 *   2. Balance check UP FRONT (nice-UX fail-fast — the worker also
 *      re-checks via reserveCredits, but catching it here lets us
 *      redirect straight to /settings/credits).
 *   3. Insert generation_jobs row (pickedPipeline='polish29_seedance',
 *      format='polish29_seedance') so it shows up in /runs and the
 *      dashboard immediately.
 *   4. inngest.send('generation/polish29-seedance.requested').
 *   5. Redirect to /runs/[id] where the job's status + resulting
 *      video URL will surface as the worker completes.
 *
 * The Dreamina account is intentionally NOT a user field — for MVP
 * we route everyone through the single platform-registered account
 * (USEAPI_NET_DEFAULT_DREAMINA_ACCOUNT env var). Round-robin across
 * a pool ships when we outgrow one account's ~150-vids/month cap.
 */

export interface StartSeedanceGenerationInput {
  prompt: string;
  /**
   * Credit-pricing model id. Polish-29.0.9 Commit 118:
   * 'seedance-2-5-ugc' (40 cr) | 'seedance-2-0-ugc' (20 cr)
   * | 'seedance-2-0-fast-ugc' (10 cr). Defaults to 'seedance-2-5-ugc'.
   */
  modelId?: string;
  aspectRatio?: '9:16' | '1:1' | '16:9';
  durationSeconds?: 5 | 8;
  resolution?: '720p' | '1080p';
  /** Optional — attach the run to a concept so the row shows up in the concept view. */
  conceptId?: string;
}

const ALLOWED_MODEL_IDS = new Set([
  'seedance-2-5-ugc',
  'seedance-2-0-ugc',
  'seedance-2-0-fast-ugc',
]);

export interface StartSeedanceGenerationResult {
  ok: boolean;
  errorMessage?: string;
  /** Route to redirect to after successful dispatch — /runs/[id]. */
  runHref?: string;
}

const DEFAULT_MODEL_ID = 'seedance-2-5-ugc';
const MAX_PROMPT_CHARS = 2000;

export async function startSeedanceGeneration(
  input: StartSeedanceGenerationInput,
): Promise<StartSeedanceGenerationResult> {
  const prompt = input.prompt.trim();
  if (!prompt) return { ok: false, errorMessage: 'Prompt is required.' };
  if (prompt.length > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      errorMessage: `Prompt too long (${prompt.length}/${MAX_PROMPT_CHARS} chars). Trim it and retry.`,
    };
  }

  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Fail-fast balance check. reserveCredits (inside the worker) is
  // still the source of truth — this is just to spare the user a
  // "job created → immediately failed" bounce when they're clearly short.
  const modelId =
    input.modelId && ALLOWED_MODEL_IDS.has(input.modelId) ? input.modelId : DEFAULT_MODEL_ID;
  const preview = getModelCostPreview(modelId);
  if (!preview) return { ok: false, errorMessage: 'Model not configured.' };
  const balance = await getCreditBalance(user.id);
  if (balance.balance < preview.credits) {
    return {
      ok: false,
      errorMessage: `Not enough credits — ${preview.displayName} costs ${preview.credits}, you have ${balance.balance}. Top up on /settings/credits and try again.`,
    };
  }

  const dreaminaAccount = process.env['USEAPI_NET_DEFAULT_DREAMINA_ACCOUNT'];
  if (!dreaminaAccount) {
    return {
      ok: false,
      errorMessage:
        'The Dreamina account is not configured on this deployment. An admin needs to set USEAPI_NET_DEFAULT_DREAMINA_ACCOUNT.',
    };
  }

  const db = getDb();
  const [job] = await db
    .insert(schema.generationJobs)
    .values({
      userId: user.id,
      pickedPipeline: 'polish29_seedance',
      format: 'polish29_seedance',
      status: 'queued',
      mode: 'live',
      variantCount: 1,
      providerChoice: 'useapi_net',
      conceptIds: input.conceptId ? [input.conceptId] : [],
      metadata: {
        source: 'quick_seedance_form',
        seedance_prompt: prompt,
        seedance_model_id: modelId,
        seedance_aspect_ratio: input.aspectRatio ?? '9:16',
        seedance_duration_seconds: input.durationSeconds ?? 5,
        seedance_resolution: input.resolution ?? '720p',
        dreamina_account: dreaminaAccount,
      },
    })
    .returning({ id: schema.generationJobs.id });
  if (!job) {
    return { ok: false, errorMessage: 'Could not create the generation job row.' };
  }

  await inngest.send({
    name: 'generation/polish29-seedance.requested',
    data: {
      jobId: job.id,
      userId: user.id,
      dreaminaAccount,
      prompt,
      modelId,
      aspectRatio: input.aspectRatio,
      durationSeconds: input.durationSeconds,
      resolution: input.resolution,
    },
  });

  return { ok: true, runHref: `/runs/${job.id}` };
}
