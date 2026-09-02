'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq, isNull, inArray } from 'drizzle-orm';
import {
  MAX_VARIANTS_PER_JOB,
  describePipeline,
  estimateGenerationCost,
  pipelineFromString,
  type ConceptType,
  type UgcVideoProvider,
} from '@mbb/shared';
import { assertDailyCostCap, decryptSecret, getDb, logAuditEvent, schema } from '@mbb/db';
import {
  detectCreativeFormat,
  pickPipeline,
  pipelineLabel,
  type DetectedFormat,
  type Pipeline,
  type PipelineUserConnections,
} from '@mbb/ai-providers';
import { auditMetaFromHeaders } from '@/lib/audit/request-meta';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { sendGenerationJobEvent } from '@/lib/inngest/send';
import {
  isAllowedReferenceMime,
  sanitizeFilename,
  storagePathBelongsToUser,
} from './reference-upload-helpers';
import {
  AI_PROVIDER_QUERY_LIST,
  buildConnectedProviders,
  type ConnectedProviders,
} from './connected-providers-helper';

export type { ConnectedProviders } from './connected-providers-helper';

export interface CreateGenerationJobResult {
  ok: boolean;
  jobId?: string;
  errorMessage?: string;
}

const VALID_INTENSITY = new Set(['small', 'medium', 'big']);
const VALID_UGC_PROVIDERS: ReadonlySet<UgcVideoProvider> = new Set(['kie_ai', 'heygen', 'arcads']);

/**
 * Polish-14.1: defensive clamp on a client-submitted source video
 * duration. Mirrors the worker's resolveTargetDuration range so the
 * cost estimate matches what the worker will use. Returns null when
 * the value is missing, NaN, negative, or zero — caller falls back
 * to the 30s default in the estimator + worker.
 */
function clampSourceDuration(raw: number): number | null {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  // Inline constants — match worker's MIN_TARGET_DURATION /
  // MAX_TARGET_DURATION (8s / 90s).
  return Math.max(8, Math.min(90, Math.ceil(raw)));
}
// Polish-4: creative format. avatar_talking_head=HeyGen; cinematic_voiceover=Kling+ElevenLabs.
// Polish-9.2: format is no longer accepted as a free-form input — it
// derives from the pipeline descriptor. The legacy VALID_FORMATS set
// was removed; pipelineFromString() handles validation.

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
  // Polish-9.2: pipeline is the canonical Polish-6 enum value (detected
  // OR overridden client-side). format + provider derive from the pipeline
  // descriptor — no more hardcoded 'avatar_talking_head'.
  const rawPipeline = formData.get('pipeline');
  const detectedPipeline = pipelineFromString(typeof rawPipeline === 'string' ? rawPipeline : null);
  // Polish-9: storage path for the reference creative uploaded via
  // signed URL. Optional — jobs without a reference still run.
  const rawReferencePath = formData.get('referenceStoragePath');
  const referenceStoragePath =
    typeof rawReferencePath === 'string' && rawReferencePath.length > 0 ? rawReferencePath : null;
  // Polish-14.1: client-detected source video duration. Persisted on
  // job.metadata so the worker's resolveTargetDuration() can read it
  // and pass through to Claude as target_duration_seconds. Same
  // sanity clamp as the worker — defense-in-depth against malformed
  // form payloads.
  const rawSourceDuration = formData.get('sourceDurationSeconds');
  const sourceDurationSeconds =
    typeof rawSourceDuration === 'string' && rawSourceDuration.length > 0
      ? clampSourceDuration(Number(rawSourceDuration))
      : null;
  // Polish-20 Commit 4: descriptor-driven model + provider selection
  // is the ONLY UGC video routing signal. Voice id / legacy pipeline
  // metadata deleted with the ElevenLabs + Kling Avatar v2 removal.
  const rawModelId = formData.get('modelId');
  const modelId =
    typeof rawModelId === 'string' && rawModelId.trim().length > 0 ? rawModelId.trim() : null;
  const rawProviderId = formData.get('providerId');
  const providerId =
    typeof rawProviderId === 'string' && rawProviderId.trim().length > 0
      ? rawProviderId.trim()
      : null;
  // Polish-25.3 Commit 18b: OpenAI static-ad quality tier
  // (low/medium/high). Only meaningful when pipeline = static_openai_image;
  // the worker reads it off job.metadata.static_openai_quality.
  const rawStaticQuality = formData.get('staticOpenaiQuality');
  const staticOpenaiQuality =
    rawStaticQuality === 'low' || rawStaticQuality === 'medium' || rawStaticQuality === 'high'
      ? rawStaticQuality
      : null;
  // Polish-29.0.10 Commit 120: seedance credit tier. Only meaningful
  // when pipeline = polish29_seedance_variations; persisted onto
  // job.metadata.model_id so the worker's fallback chain picks it up
  // without a bespoke event.data field.
  const rawPolish29ModelId = formData.get('polish29ModelId');
  const polish29ModelId =
    rawPolish29ModelId === 'seedance-2-0-fast-ugc' ||
    rawPolish29ModelId === 'seedance-2-0-ugc' ||
    rawPolish29ModelId === 'seedance-2-5-ugc'
      ? rawPolish29ModelId
      : null;

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

  // Polish-9.2 → Polish-20.0.2 hotfix: format + providerChoice derive
  // from the pipeline descriptor when a pipeline is explicitly sent.
  // When the simplified form submits WITHOUT a pipeline field (the
  // Polish-20.0.1+ default) AND a modelId IS present, we intentionally
  // leave pickedPipeline null — the video-variant worker routes off
  // metadata.model_id via analyze-concept's dispatch. The pre-fix
  // fallback to HeyGen wrote pickedPipeline='heygen_avatar_talking_head'
  // even when the operator had picked a Seedance/Kling model, which
  // opened a routing hole: if analyze-concept's metadata read hit any
  // edge case, dispatch fell through to the HeyGen worker instead of
  // the video-variant worker (Polish-20.0.2 production diagnostic on
  // job 84fee5b7).
  const pipelineDesc = detectedPipeline
    ? describePipeline(detectedPipeline)
    : modelId != null
      ? null // Polish-20 modelId path — pipeline stays null; dispatch reads metadata.
      : describePipeline('heygen_avatar_talking_head');
  const format = pipelineDesc?.format ?? null;

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

  // Polish-9.2 → Polish-20.0.2: pickedProvider follows the pipeline
  // descriptor for UGC when a pipeline is picked; when only modelId
  // is set (the Polish-20 default UGC path), the video-variant worker
  // reads provider_id off metadata — there's no legacy pickedProvider
  // to write here.
  let pickedProvider: UgcVideoProvider | undefined;
  if (contentType === 'ugc' && pipelineDesc) {
    if (pipelineDesc.providerChoice === 'heygen') {
      pickedProvider = 'heygen';
    } else if (provider && VALID_UGC_PROVIDERS.has(provider as UgcVideoProvider)) {
      pickedProvider = provider as UgcVideoProvider;
    } else {
      pickedProvider = undefined;
    }
  }

  // Estimate cost server-side (don't trust the client's display).
  // Polish-20.0.2: when modelId is present, route through the
  // descriptor-driven video-model branch (matches the form's preview
  // card). Otherwise fall through to the legacy pipeline branch.
  const estimate = estimateGenerationCost({
    conceptType: contentType,
    variantCount,
    provider: pickedProvider,
    ...(pipelineDesc ? { pipeline: pipelineDesc.pipeline } : {}),
    ...(modelId != null ? { videoModelId: modelId as never } : {}),
    ...(providerId != null ? { videoProviderId: providerId as never } : {}),
    sourceDurationSeconds: sourceDurationSeconds ?? undefined,
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
      providerChoice:
        pickedProvider ??
        pipelineDesc?.providerChoice ??
        (contentType === 'static' ? 'gemini+claude' : null),
      estimatedCostUsd: estimate.estimateUsd.toFixed(4),
      mode,
      status: 'queued',
      // Polish-4 → Polish-20.0.2: format persisted at job-creation
      // time for the LEGACY pipeline survivors (heygen / sora /
      // nano-banana). When only modelId is set, we OMIT this field
      // so the column default ('avatar_talking_head') lands but the
      // video-variant worker doesn't read format anyway.
      ...(format != null ? { format } : {}),
      // Polish-9.2 → Polish-20.0.2: pickedPipeline persisted for
      // legacy dispatch. Left null when only modelId is set so
      // analyze-concept's dispatch can't accidentally fall through
      // to a wrong worker (the pre-20.0.2 forced HeyGen fallback
      // caused this on job 84fee5b7).
      pickedPipeline: pipelineDesc?.pipeline ?? null,
      // Polish-9: reference creative storage path (auto-detect upload).
      ...(referenceStoragePath ? { referenceCreativeStoragePath: referenceStoragePath } : {}),
      // Polish-14.1 + Polish-20 Commit 4: persist descriptor-driven
      // routing signals + source duration. The video-variant worker
      // reads model_id + provider_id to look up ModelProviderConfig
      // and dispatches accordingly. All fields nullable — workers
      // tolerate absent columns and fall back to safe defaults.
      ...(sourceDurationSeconds != null ||
      modelId != null ||
      providerId != null ||
      staticOpenaiQuality != null ||
      polish29ModelId != null
        ? {
            metadata: {
              ...(sourceDurationSeconds != null
                ? { source_duration_seconds: sourceDurationSeconds }
                : {}),
              ...(modelId != null ? { model_id: modelId } : {}),
              ...(providerId != null ? { provider_id: providerId } : {}),
              // Polish-25.3 Commit 18b: quality tier surfaces to the
              // static-openai worker via extractQuality(metadata).
              ...(staticOpenaiQuality != null
                ? { static_openai_quality: staticOpenaiQuality }
                : {}),
              // Polish-29.0.10 Commit 120: seedance credit tier for
              // the variations pipeline. NOT stored under `model_id`
              // because analyze-concept's dispatch would route jobs
              // with metadata.model_id through video-variant. Kept in
              // its own key so the worker reads it via a bespoke
              // lookup and pickedPipeline routing stays the source of
              // truth for the dispatch.
              ...(polish29ModelId != null ? { polish29_model_id: polish29ModelId } : {}),
            },
          }
        : {}),
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
      provider_choice: pickedProvider ?? pipelineDesc?.providerChoice ?? null,
      pipeline: pipelineDesc?.pipeline ?? null,
      // Polish-20.0.2: audit-log the descriptor-driven routing signals
      // alongside the legacy pipeline/format so a future dispatch
      // regression is traceable via the audit trail.
      model_id: modelId,
      provider_id: providerId,
      estimated_cost_usd: estimate.estimateUsd,
      mode,
      format: format ?? null,
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
    // Polish-25.3 Commit 18b: static pipelines dispatch directly
    // via the descriptor's workerEvent (see resolveEventName in
    // apps/web/lib/inngest/send.ts). UGC always fans through
    // analyze-concept regardless.
    pickedPipeline: pipelineDesc?.pipeline ?? null,
  });

  revalidatePath(`/concepts/${conceptId}`);
  return { ok: true, jobId };
}

/**
 * Polish-4 / Polish-9.3: which providers does the user have active
 * connections for? Powers the form's pipeline picker — we only offer
 * pipelines the user has the keys to actually run.
 *
 * Polish-9.3: kling capability fills from either a 'kling' DB row OR
 * a 'replicate' DB row (the Polish-8 UI card stores under the
 * 'replicate' enum value but Replicate is the host for Kling 3.0 in
 * our architecture). See buildConnectedProviders for the mapping.
 */
// Polish-20 Commit 4: loadKieAiBalance + KieBalanceResult deleted
// alongside the kie-omni client that exposed getKieAiBalance. The
// Polish-16 Fix 1 kie.ai pre-flight balance check may return in a
// Polish-21 form iteration once we have a stable public endpoint;
// for now the operator sees only the dollar-cost estimate.

export async function loadConnectedProviders(userId: string): Promise<ConnectedProviders> {
  const db = getDb();
  const aiRows = await db.query.aiProviderConnections.findMany({
    where: and(
      eq(schema.aiProviderConnections.userId, userId),
      eq(schema.aiProviderConnections.status, 'active'),
      isNull(schema.aiProviderConnections.deletedAt),
      inArray(schema.aiProviderConnections.provider, [...AI_PROVIDER_QUERY_LIST]),
    ),
    columns: { provider: true, tier: true },
  });
  const toolRows = await db.query.toolConnections.findMany({
    where: and(
      eq(schema.toolConnections.userId, userId),
      eq(schema.toolConnections.status, 'active'),
      isNull(schema.toolConnections.deletedAt),
    ),
    columns: { provider: true },
  });
  return buildConnectedProviders(aiRows, new Set(toolRows.map((r) => r.provider)));
}

// =========================================================================
// Polish-6: auto-detect + route
// =========================================================================

export interface DetectAndRouteResult {
  ok: boolean;
  detection?: DetectedFormat;
  pipeline?: Pipeline;
  pipelineLabel?: string;
  errorMessage?: string;
}

export interface CreateUploadUrlResult {
  ok: boolean;
  uploadUrl?: string;
  storagePath?: string;
  token?: string;
  errorMessage?: string;
}

/**
 * Polish-9: create a Supabase Storage signed upload URL for a reference
 * creative. Replaces the previous base64-over-server-action flow which
 * crashed on Vercel's 4.5 MB body limit. Client uploads directly to
 * Supabase via PUT.
 *
 * Path convention: <userId>/<uuid>/<filename> — matches the storage
 * RLS policy in migration 0028 (split_part(name, '/', 1) = auth.uid()).
 */
export async function createReferenceUploadUrl(
  filename: string,
  contentType: string,
): Promise<CreateUploadUrlResult> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, errorMessage: 'Not logged in.' };

  if (!isAllowedReferenceMime(contentType)) {
    return {
      ok: false,
      errorMessage: `Unsupported file type: ${contentType}. Use mp4 / mov / webm / png / jpeg / webp.`,
    };
  }
  const safeFilename = sanitizeFilename(filename);
  const uniqueDir = crypto.randomUUID();
  const storagePath = `${user.id}/${uniqueDir}/${safeFilename}`;

  const { data, error } = await supabase.storage
    .from('reference-creatives')
    .createSignedUploadUrl(storagePath);
  if (error || !data) {
    return {
      ok: false,
      errorMessage: error?.message ?? 'Could not create upload URL.',
    };
  }
  return {
    ok: true,
    uploadUrl: data.signedUrl,
    token: data.token,
    storagePath,
  };
}

/**
 * Polish-9: run vision detection on a file already uploaded to Supabase
 * Storage. Downloads the file server-side and runs the same flow that
 * detectAndRouteAction used to run on a base64 client payload.
 *
 * For videos: extracts a single frame (the first one) — multi-frame
 * extraction needs ffmpeg in the runtime, deferred to a future patch.
 * Images go directly to Claude vision.
 */
export async function detectAndRouteFromStoragePath(
  storagePath: string,
  contentType: string,
): Promise<DetectAndRouteResult> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, errorMessage: 'Not logged in.' };

  if (!storagePathBelongsToUser(storagePath, user.id)) {
    return { ok: false, errorMessage: 'Invalid storage path.' };
  }

  const { data: blob, error: dlError } = await supabase.storage
    .from('reference-creatives')
    .download(storagePath);
  if (dlError || !blob) {
    return {
      ok: false,
      errorMessage: dlError?.message ?? 'Could not download uploaded file.',
    };
  }

  // For now we send the first ~5 MB of the file to Claude vision as a
  // single frame. Images fit fully; videos give Claude the first chunk
  // (still useful since most ad creatives lead with the key visual in
  // frame 1). Real ffmpeg-based multi-frame extraction is a follow-up.
  const buffer = await blob.arrayBuffer();
  const capped = buffer.byteLength > 5 * 1024 * 1024 ? buffer.slice(0, 5 * 1024 * 1024) : buffer;
  const base64 = Buffer.from(capped).toString('base64');
  const detectMediaType = contentType.startsWith('video/') ? 'image/jpeg' : contentType;

  const db = getDb();
  const claudeConn = await db.query.toolConnections.findFirst({
    where: and(
      eq(schema.toolConnections.userId, user.id),
      eq(schema.toolConnections.provider, 'claude'),
      eq(schema.toolConnections.status, 'active'),
      isNull(schema.toolConnections.deletedAt),
    ),
    columns: { apiKeyEncrypted: true },
  });
  if (!claudeConn) {
    return {
      ok: false,
      errorMessage: 'Connect Claude on /connections/tools to enable auto-detection.',
    };
  }
  let claudeKey: string;
  try {
    claudeKey = await decryptSecret(claudeConn.apiKeyEncrypted);
  } catch {
    return { ok: false, errorMessage: 'Could not decrypt Claude key.' };
  }

  const detectionResult = await detectCreativeFormat({
    userId: user.id,
    claudeApiKey: claudeKey,
    frames: [{ base64, mediaType: detectMediaType }],
  });
  if (!detectionResult.ok || !detectionResult.detection) {
    return {
      ok: false,
      errorMessage: detectionResult.errorMessage ?? 'Vision detection failed.',
    };
  }

  const providers = await loadConnectedProviders(user.id);
  const pipelineConnections: PipelineUserConnections = {
    heygen: { connected: providers.heygen.connected, tier: providers.heygen.tier },
    openai: { connected: providers.openai.connected },
    gemini: { connected: providers.gemini.connected },
  };
  const routeResult = pickPipeline(
    { format: detectionResult.detection.format },
    pipelineConnections,
  );
  if (!routeResult.ok) {
    return {
      ok: true,
      detection: detectionResult.detection,
      errorMessage: routeResult.errorMessage,
    };
  }
  return {
    ok: true,
    detection: detectionResult.detection,
    pipeline: routeResult.pipeline,
    pipelineLabel: pipelineLabel(routeResult.pipeline),
  };
}
