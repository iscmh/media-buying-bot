'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq, isNull, inArray } from 'drizzle-orm';
import {
  MAX_VARIANTS_PER_JOB,
  estimateGenerationCost,
  type ConceptType,
  type UgcVideoProvider,
} from '@mbb/shared';
import { assertDailyCostCap, getDb, logAuditEvent, schema } from '@mbb/db';
import { auditMetaFromHeaders } from '@/lib/audit/request-meta';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { sendGenerationJobEvent } from '@/lib/inngest/send';

export interface CreateGenerationJobResult {
  ok: boolean;
  jobId?: string;
  errorMessage?: string;
}

const VALID_INTENSITY = new Set(['small', 'medium', 'big']);
const VALID_UGC_PROVIDERS: ReadonlySet<UgcVideoProvider> = new Set(['kie_ai', 'heygen', 'arcads']);
// Polish-4: creative format. avatar_talking_head=HeyGen; cinematic_voiceover=Kling+ElevenLabs.
const VALID_FORMATS = new Set(['avatar_talking_head', 'cinematic_voiceover']);

/**
 * Create a generation job. Pre-flight gates BEFORE any Inngest send:
 *
 *   1. Auth + concept ownership (RLS bypass via service-role, but we
 *      verify the concept belongs to this user).
 *   2. Variant count <= MAX_VARIANTS_PER_JOB (100). Hard cap.
 *   3. Cost estimate <= remaining daily cap (TZ-aware via
 *      assertDailyCostCap).
 *   4. BOT_DRY_RUN=true → mode='mock'. False (Phase 3b+) → mode='live'.
 *
 * Phase 3a always lands in 'mock' mode. Phase 3b will read BOT_DRY_RUN.
 *
 * On success: writes the generation_jobs row, audit-logs, and sends the
 * matching Inngest event.
 */
export async function createGenerationJobAction(
  formData: FormData,
): Promise<CreateGenerationJobResult> {
  const conceptId = String(formData.get('conceptId') ?? '');
  const intensity = String(formData.get('intensity') ?? '');
  const variantCount = Number(formData.get('variantCount') ?? 0);
  const provider = String(formData.get('provider') ?? '') as UgcVideoProvider | '';
  // Polish-4: creative format. Defaults to avatar_talking_head so a
  // client that doesn't send the field gets the legacy HeyGen path.
  const format = String(formData.get('format') ?? 'avatar_talking_head');

  if (!conceptId) return { ok: false, errorMessage: 'Missing concept id.' };
  if (!VALID_INTENSITY.has(intensity)) {
    return { ok: false, errorMessage: 'Pick an intensity.' };
  }
  if (!Number.isInteger(variantCount) || variantCount < 1) {
    return { ok: false, errorMessage: 'Variant count must be a positive whole number.' };
  }
  if (variantCount > MAX_VARIANTS_PER_JOB) {
    return {
      ok: false,
      errorMessage: `Variant count cannot exceed ${MAX_VARIANTS_PER_JOB} per job.`,
    };
  }
  if (!VALID_FORMATS.has(format)) {
    return { ok: false, errorMessage: 'Unknown creative format.' };
  }

  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const db = getDb();
  const concept = await db.query.concepts.findFirst({
    where: and(
      eq(schema.concepts.id, conceptId),
      eq(schema.concepts.userId, user.id),
      isNull(schema.concepts.deletedAt),
    ),
    columns: { contentType: true },
  });
  if (!concept) {
    return { ok: false, errorMessage: 'Concept not found.' };
  }
  const contentType = concept.contentType as ConceptType;

  // UGC: provider is force-picked to 'heygen' (Phase 3f — Avatar Mode is
  // the only supported path; Kie.ai/Arcads code retained but unused).
  // If a stale client still POSTs `provider`, honor it only when valid;
  // otherwise default to heygen so the call doesn't error out.
  let pickedProvider: UgcVideoProvider | undefined;
  if (contentType === 'ugc') {
    if (provider && VALID_UGC_PROVIDERS.has(provider as UgcVideoProvider)) {
      pickedProvider = provider as UgcVideoProvider;
    } else {
      pickedProvider = 'heygen';
    }
  }

  // Estimate cost server-side (don't trust the client's display).
  const estimate = estimateGenerationCost({
    conceptType: contentType,
    variantCount,
    provider: pickedProvider,
  });

  // Cost cap. Counts both mock + live jobs against the per-user daily cap
  // (Phase 3a invariant — server clamp is the same for both modes).
  const cap = await assertDailyCostCap(user.id, estimate.estimateUsd);
  if (!cap.allowed) {
    return { ok: false, errorMessage: cap.reason };
  }

  // UI no longer surfaces a mode toggle (Polish-3) — every job is 'live'.
  // The form data may still carry 'mode' from CLI/dev callers; respect
  // it for tests but default to 'live'. The liveGenerationAcknowledgedAt
  // check stays as defense in depth — the form gates the dialog
  // client-side too.
  const requestedMode = String(formData.get('mode') ?? 'live');
  let mode: 'mock' | 'live';
  if (requestedMode === 'live') {
    const userRow = await db.query.users.findFirst({
      where: eq(schema.users.id, user.id),
      columns: { id: true },
    });
    if (!userRow) {
      return { ok: false, errorMessage: 'User row not found.' };
    }
    const settings = await db.query.userSettings.findFirst({
      where: eq(schema.userSettings.userId, user.id),
      columns: { liveGenerationAcknowledgedAt: true },
    });
    if (!settings?.liveGenerationAcknowledgedAt) {
      return {
        ok: false,
        errorMessage: 'Confirm the live-spend dialog before generating.',
      };
    }
    mode = 'live';
  } else {
    mode = 'mock';
  }

  // Insert job row.
  const [row] = await db
    .insert(schema.generationJobs)
    .values({
      userId: user.id,
      conceptIds: [conceptId],
      intensity,
      variantCount,
      providerChoice: pickedProvider ?? (contentType === 'static' ? 'gemini+claude' : null),
      estimatedCostUsd: estimate.estimateUsd.toFixed(4),
      mode,
      status: 'queued',
      // Polish-4: creative format persisted at job-creation time. The
      // analyze-concept worker reads this to fan out to either the
      // ugc.requested (HeyGen) or cinematic.requested (Kling) worker.
      format,
      // Phase 1's enum aiProviderUsed: only populate when UGC + provider is
      // also one of arcads/heygen/creatify. Kie.ai isn't in that enum, so
      // leave null when picked.
      aiProviderUsed:
        pickedProvider === 'heygen' || pickedProvider === 'arcads' ? pickedProvider : null,
    })
    .returning({ id: schema.generationJobs.id });

  const jobId = row?.id;
  if (!jobId) {
    return { ok: false, errorMessage: 'Could not create job row.' };
  }

  await logAuditEvent({
    userId: user.id,
    eventType: 'generation_job_created',
    eventData: {
      job_id: jobId,
      concept_id: conceptId,
      content_type: contentType,
      intensity,
      variant_count: variantCount,
      provider_choice: pickedProvider ?? 'gemini+claude',
      estimated_cost_usd: estimate.estimateUsd,
      mode,
      format,
      _meta: await auditMetaFromHeaders(),
    },
  });

  // Hand off to Inngest. analyze-concept gates ugc; static skips straight
  // to generation. Both jobs use mock data when mode='mock'.
  await sendGenerationJobEvent({
    contentType,
    jobId,
    userId: user.id,
    mode,
  });

  revalidatePath(`/concepts/${conceptId}`);
  return { ok: true, jobId };
}

/**
 * Polish-4: which providers does the user have active connections for?
 * Powers the form's provider + format pickers — we only offer formats
 * the user has the keys to actually generate. Returns a flat shape the
 * client can pass into the picker without further lookups.
 */
export interface ConnectedProviders {
  heygen: { connected: boolean; tier: 'free' | 'pro' | 'premium' | null };
  kling: { connected: boolean };
  elevenlabs: { connected: boolean };
}

export async function loadConnectedProviders(userId: string): Promise<ConnectedProviders> {
  const db = getDb();
  const rows = await db.query.aiProviderConnections.findMany({
    where: and(
      eq(schema.aiProviderConnections.userId, userId),
      eq(schema.aiProviderConnections.status, 'active'),
      isNull(schema.aiProviderConnections.deletedAt),
      inArray(schema.aiProviderConnections.provider, ['heygen', 'kling', 'elevenlabs']),
    ),
    columns: { provider: true, tier: true },
  });
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return {
    heygen: {
      connected: byProvider.has('heygen'),
      tier:
        (byProvider.get('heygen')?.tier as 'free' | 'pro' | 'premium' | null | undefined) ?? null,
    },
    kling: { connected: byProvider.has('kling') },
    elevenlabs: { connected: byProvider.has('elevenlabs') },
  };
}
