import { eq } from 'drizzle-orm';
import {
  callClaude,
  callGeminiImage,
  getUniversalUgcMasterPrompt,
  submitKlingVideo,
  checkKlingPrediction,
} from '@mbb/ai-providers';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';
import { uploadGeneratedImage } from '../lib/storage';

/**
 * Polish-6 item 4: Kling 3.0 multi-clip native lipsync pipeline.
 *
 * Uses the UNIVERSAL_UGC_MASTER_PROMPT (loaded verbatim from .md) as
 * Claude's system prompt. Claude produces a Complete Video Production
 * Manual with character_prompt, set_prompt, and ~16 clips (6s each).
 * Each clip gets a first-frame image gen (deferred to Kling image-to-
 * video with text prompt for now) + a Kling video generation call.
 *
 * PROMPT FIDELITY: the master prompt is loaded via getUniversalUgc-
 * MasterPrompt() from the .md file, never modified or inlined.
 *
 * Cost: ~$4.80 per variant (16 clips × $0.30 Kling each). Surfaced
 * in the cost estimator so the user sees it before submitting.
 */

const CLIPS_PER_VARIANT = 16;
const CLIP_DURATION_SECONDS = 6;
const CONCURRENCY = 3;
// Polish-9.6: poll ceiling = POLL_INTERVAL × POLL_MAX_ATTEMPTS. Default
// 15s × 40 = 600s = 10 min per clip (matches REPLICATE_POLL_TIMEOUT_MS
// spec ceiling). REPLICATE_POLL_TIMEOUT_MS env overrides the ceiling
// without touching the interval — useful when Replicate gets slow.
const REPLICATE_POLL_TIMEOUT_MS = Number(process.env.REPLICATE_POLL_TIMEOUT_MS) || 600_000;
const POLL_INTERVAL_SECONDS = 15;
const POLL_MAX_ATTEMPTS = Math.ceil(REPLICATE_POLL_TIMEOUT_MS / 1000 / POLL_INTERVAL_SECONDS);
const MOCK_VIDEO_URL = 'https://samplelib.com/lib/preview/mp4/sample-5s.mp4';

export const generateKlingMultiClipVariants = inngest.createFunction(
  {
    id: 'generate-kling-multi-clip-variants',
    name: 'Generate Kling 3.0 multi-clip variants',
    retries: 1,
  },
  { event: 'generation/kling-multi-clip.requested' },
  async ({ event, step }) => {
    const { jobId, userId, mode } = event.data;
    const startedAt = Date.now();

    const job = await step.run('load-job', async () => {
      const db = getDb();
      return db.query.generationJobs.findFirst({
        where: eq(schema.generationJobs.id, jobId),
        columns: { variantCount: true, metadata: true },
      });
    });
    const variantCount = job?.variantCount ?? 0;
    if (variantCount <= 0) {
      await markJobFailed(jobId, userId, 'variant_count missing', 0);
      return { jobId, mode, generated: 0 };
    }

    await step.run('mark-processing', async () => {
      const db = getDb();
      await db
        .update(schema.generationJobs)
        .set({ status: 'processing' })
        .where(eq(schema.generationJobs.id, jobId));
    });

    // mock path
    if (mode === 'mock') {
      await step.sleep('mock-render', '2s');
      await step.run('insert-mock-creatives', async () => {
        const db = getDb();
        const rows = Array.from({ length: variantCount * CLIPS_PER_VARIANT }, (_, i) => ({
          userId,
          generationJobId: jobId,
          fileUrl: MOCK_VIDEO_URL,
          aspectRatio: '9:16' as const,
          status: 'ready_for_review' as const,
          format: 'kling_3_multi_clip',
          clipIndex: i % CLIPS_PER_VARIANT,
          isClipPart: true,
          generationMetadata: { mock: true, clip_index: i % CLIPS_PER_VARIANT },
        }));
        await db.insert(schema.generatedCreatives).values(rows);
      });
      await markJobCompleted({
        jobId,
        userId,
        mode,
        startedAt,
        variantCount,
        actualCostUsd: 0,
        provider: 'kling',
        path: 'kling-multi-clip',
      });
      return { jobId, mode, generated: variantCount };
    }

    // live: ask Claude to build the production manual
    const manualResult = await step.run('claude-production-manual', async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['claude']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          return { ok: false as const, error: err.message, costUsd: 0 };
        }
        throw err;
      }

      const systemPrompt = getUniversalUgcMasterPrompt();
      const analysis = job?.metadata ?? {};
      const userMessage = JSON.stringify({
        analysis,
        variant_count: variantCount,
        clips_per_variant: CLIPS_PER_VARIANT,
        clip_duration_seconds: CLIP_DURATION_SECONDS,
      });

      const claude = await callClaude({
        userId,
        apiKey: keys.claude!,
        systemPrompt,
        userMessage,
        maxTokens: 16384,
        generationJobId: jobId,
      });
      if (!claude.ok) {
        console.log(`[kling-manual] Claude call failed: ${claude.errorMessage ?? 'unknown'}`);
        return {
          ok: false as const,
          error: claude.errorMessage ?? 'Claude manual generation failed',
          costUsd: claude.costUsd,
        };
      }
      // Polish-9.7: capture raw output for diagnostics. The parser used
      // to silently fall back to a single bad clip on non-JSON; now it
      // hard-fails with a clear error and we log the first 1000 chars
      // so the Inngest dashboard shows what Claude actually returned.
      console.log(
        `[kling-manual] Claude returned ${(claude.text ?? '').length} chars; ` +
          `first 1000: ${(claude.text ?? '').slice(0, 1000)}`,
      );
      const parsed = parseProductionManual(claude.json ?? claude.text);
      if (!parsed.ok) {
        console.log(`[kling-manual] parse failed: ${parsed.error}`);
        return { ok: false as const, error: parsed.error, costUsd: claude.costUsd };
      }
      const expectedTotal = variantCount * CLIPS_PER_VARIANT;
      if (parsed.manual.clips.length !== expectedTotal) {
        console.log(
          `[kling-manual] parsed ${parsed.manual.clips.length} clips (expected ${expectedTotal}); proceeding with what we have`,
        );
      }
      return { ok: true as const, manual: parsed.manual, costUsd: claude.costUsd };
    });

    if (!manualResult.ok) {
      await markJobFailed(jobId, userId, manualResult.error, manualResult.costUsd);
      return { jobId, mode, generated: 0 };
    }

    const { manual } = manualResult;
    let totalCost = manualResult.costUsd;
    let successCount = 0;

    // For each clip, generate via Kling
    for (let batchStart = 0; batchStart < manual.clips.length; batchStart += CONCURRENCY) {
      const batch = manual.clips.slice(batchStart, batchStart + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (clip, idxInBatch) => {
          const clipIndex = batchStart + idxInBatch;

          // Polish-9.8: generate first-frame via Nano Banana so Kling has
          // an image to anchor the character + scene. Without this, Kling
          // invents a fresh face for every clip and the 16-clip variant
          // looks like 16 different actors. The master prompt's [USE
          // IMAGE X AS STARTING FRAME] directive expects this image.
          const frameResult = await step.run(`nano-banana-frame-${clipIndex}`, async () => {
            let keys;
            try {
              keys = await loadDecryptedKeys(userId, ['gemini']);
            } catch (err) {
              if (err instanceof MissingProviderKeyError)
                return { ok: false as const, error: err.message, costUsd: 0 };
              throw err;
            }
            const imagePrompt = buildImagePromptForClip(manual, clip);
            const image = await callGeminiImage({
              userId,
              apiKey: keys.gemini!,
              prompt: imagePrompt,
              generationJobId: jobId,
            });
            if (!image.ok || !image.imageBase64 || !image.imageMimeType) {
              return {
                ok: false as const,
                error: image.errorMessage ?? 'Nano Banana returned no image',
                costUsd: image.costUsd,
              };
            }
            try {
              const upload = await uploadGeneratedImage({
                userId,
                jobId,
                variantIndex: clipIndex,
                imageBase64: image.imageBase64,
                mimeType: image.imageMimeType,
                filenamePrefix: 'kling-frame-',
              });
              return { ok: true as const, publicUrl: upload.publicUrl, costUsd: image.costUsd };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return {
                ok: false as const,
                error: `First-frame upload failed: ${msg}`,
                costUsd: image.costUsd,
              };
            }
          });

          if (!frameResult.ok) {
            console.log(`[kling-clip-${clipIndex}] nano-banana frame failed: ${frameResult.error}`);
            return { clipIndex, ok: false, costUsd: frameResult.costUsd, error: frameResult.error };
          }

          // Submit Kling with the clip's video prompt + first-frame URL
          const submitResult = await step.run(`kling-submit-${clipIndex}`, async () => {
            let keys;
            try {
              keys = await loadDecryptedKeys(userId, ['kling']);
            } catch (err) {
              if (err instanceof MissingProviderKeyError)
                return { ok: false as const, error: err.message };
              throw err;
            }
            const prompt = [
              clip.videoPrompt,
              clip.dialogue && !/GENERATE NATIVE AUDIO AND LIP-SYNC/i.test(clip.videoPrompt)
                ? `[GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "${clip.dialogue}"`
                : '',
            ]
              .filter(Boolean)
              .join('\n\n');

            return submitKlingVideo({
              userId,
              apiKey: keys.kling!,
              prompt,
              durationSeconds: (clip.duration ?? CLIP_DURATION_SECONDS) <= 5 ? 5 : 10,
              aspectRatio: '9:16',
              startImageUrl: frameResult.publicUrl,
              generationJobId: jobId,
            });
          });

          if (!submitResult.ok || !('predictionId' in submitResult) || !submitResult.predictionId) {
            const err =
              'errorMessage' in submitResult
                ? submitResult.errorMessage
                : 'error' in submitResult
                  ? submitResult.error
                  : 'submit failed';
            console.log(`[kling-clip-${clipIndex}] submit failed: ${err}`);
            return { clipIndex, ok: false, costUsd: frameResult.costUsd, error: err };
          }

          // Poll
          let videoUrl: string | undefined;
          let pollCostUsd = 0;
          let pollError: string | undefined;
          for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
            await step.sleep(`kling-poll-${clipIndex}-${attempt}`, `${POLL_INTERVAL_SECONDS}s`);
            const tick = await step.run(`kling-check-${clipIndex}-${attempt}`, async () => {
              const keys = await loadDecryptedKeys(userId, ['kling']);
              return checkKlingPrediction({
                userId,
                apiKey: keys.kling!,
                predictionId: submitResult.predictionId!,
                generationJobId: jobId,
              });
            });
            if (tick.status === 'completed') {
              videoUrl = tick.videoUrl;
              pollCostUsd = tick.costUsd;
              break;
            }
            if (tick.status === 'failed') {
              pollError = tick.errorMessage ?? 'Kling clip failed';
              break;
            }
          }

          if (!videoUrl) {
            const err =
              pollError ??
              `Kling clip timed out after ${POLL_MAX_ATTEMPTS} polls ` +
                `(${POLL_INTERVAL_SECONDS}s interval = ${(POLL_MAX_ATTEMPTS * POLL_INTERVAL_SECONDS) / 60} min ceiling)`;
            console.log(`[kling-clip-${clipIndex}] ${err}`);
            return {
              clipIndex,
              ok: false,
              costUsd: pollCostUsd + frameResult.costUsd,
              error: err,
            };
          }

          // Persist the clip row
          await step.run(`write-clip-${clipIndex}`, async () => {
            const db = getDb();
            await db.insert(schema.generatedCreatives).values({
              userId,
              generationJobId: jobId,
              fileUrl: videoUrl!,
              aspectRatio: '9:16',
              status: 'ready_for_review',
              format: 'kling_3_multi_clip',
              clipIndex,
              isClipPart: true,
              generationMetadata: {
                character_prompt: manual.characterPrompt,
                set_prompt: manual.setPrompt,
                video_prompt: clip.videoPrompt,
                image_prompt: clip.imagePrompt,
                dialogue: clip.dialogue,
                motion_type: clip.motionType,
                first_frame_url: frameResult.publicUrl,
                clip_index: clipIndex,
              },
            });
          });

          return { clipIndex, ok: true, costUsd: pollCostUsd + frameResult.costUsd };
        }),
      );

      for (const r of results) {
        totalCost += r.costUsd;
        if (r.ok) successCount++;
      }
    }

    // Polish-9.7: fail-fast when zero clips succeed. The previous code
    // marked the job 'completed' with 0 generated_creatives rows, which
    // looked like a successful run in the UI but produced nothing.
    const outcome = decideKlingJobOutcome({
      successCount,
      totalClips: manual.clips.length,
      clipsPerVariant: CLIPS_PER_VARIANT,
    });
    if (outcome.kind === 'fail') {
      console.log(`[kling-job] 0 of ${manual.clips.length} clips succeeded — marking job failed`);
      await markJobFailed(jobId, userId, outcome.error, totalCost);
      return { jobId, mode, generated: 0, totalCost };
    }

    await markJobCompleted({
      jobId,
      userId,
      mode,
      startedAt,
      variantCount: outcome.variantCount,
      actualCostUsd: totalCost,
      provider: 'kling',
      path: 'kling-multi-clip',
    });

    return { jobId, mode, generated: successCount, totalCost };
  },
);

// =========================================================================
// Parser
// =========================================================================

interface ClipSpec {
  /** 1-indexed clip number derived from the [USE IMAGE X] directive's X. */
  clipNumber: number;
  /** The image index this clip animates from (same as clipNumber by construction). */
  startingFrameImage: number;
  /**
   * Full Kling prompt body — everything from this clip's [USE IMAGE X]
   * directive to the next clip's directive (or end of Section C). Sent
   * to Kling verbatim because Kling 3.0's grammar consumes the bracket
   * directives natively.
   */
  videoPrompt: string;
  dialogue?: string;
  duration?: number;
  motionType?: string;
  /**
   * Optional clip-specific image prompt. Polish-9.10 no longer extracts
   * per-image entries from Section B (too format-variable); always
   * undefined. The worker falls back to character + set + section-B
   * imageGuidance + clip.videoPrompt via buildImagePromptForClip.
   */
  imagePrompt?: string;
}

interface ProductionManual {
  characterPrompt: string;
  setPrompt: string;
  /**
   * Section B body captured as one string — passed to Nano Banana
   * alongside character + set + clip context so the first frame can
   * reference whatever Claude wrote about images.
   */
  imageGuidance: string;
  clips: ClipSpec[];
}

/**
 * Polish-9.7: pure decision for whether a finished clip loop should
 * mark the job 'failed' (zero successes) or 'completed' (at least one).
 * Exported for unit tests. Mirrored inline in the Inngest function so
 * step boundaries don't need re-mapping.
 */
export function decideKlingJobOutcome(input: {
  successCount: number;
  totalClips: number;
  clipsPerVariant: number;
}): { kind: 'fail'; error: string } | { kind: 'complete'; variantCount: number } {
  if (input.successCount === 0) {
    return {
      kind: 'fail',
      error: `All ${input.totalClips} clips failed. Check per-clip errors in the Inngest run.`,
    };
  }
  return {
    kind: 'complete',
    variantCount: Math.ceil(input.successCount / input.clipsPerVariant),
  };
}

/**
 * Polish-9.10: anchor clip parsing on the [USE IMAGE X AS STARTING
 * FRAME] directive — the only thing the master prompt forces Claude
 * to emit verbatim ("Three Mandatory Elements — Always Include").
 * Polish-9.7 / 9.8 / 9.9 each chased a different surrounding-markdown
 * format (JSON, `### Clip N` + `**Field:**`, em-dash separators) and
 * each failed in production on a slightly different rendering. The
 * bracket directives don't vary, so we anchor on them instead.
 *
 * Strategy:
 *   1. Locate SECTION C header (markdown-decoration-tolerant).
 *   2. Scan for every [USE IMAGE N AS STARTING FRAME] directive.
 *   3. Each directive is a clip; body = text from this directive to
 *      the next (or end of Section C). Sent to Kling verbatim because
 *      Kling 3.0's grammar consumes [USE IMAGE X], Subject:, and
 *      [GENERATE NATIVE AUDIO...] natively.
 *   4. Section B body captured whole as `imageGuidance` and passed to
 *      Nano Banana — no per-image extraction (too format-variable).
 */
export function parseProductionManual(
  raw: unknown,
): { ok: true; manual: ProductionManual } | { ok: false; error: string } {
  if (raw == null || typeof raw !== 'string') {
    return { ok: false, error: 'Claude returned no text for the manual.' };
  }

  const text = stripCodeFences(raw);
  const sectionA = sliceSection(text, 'A');
  const characterPrompt = extractGlobalPrompt(sectionA, 'Character');
  const setPrompt = extractGlobalPrompt(sectionA, 'Set');

  if (!characterPrompt.trim()) {
    return { ok: false, error: errorWithExcerpt('Manual is missing characterPrompt', raw, 500) };
  }
  if (!setPrompt.trim()) {
    return { ok: false, error: errorWithExcerpt('Manual is missing setPrompt', raw, 500) };
  }

  const imageGuidance = sliceSection(text, 'B');

  const sectionC = sliceSectionC(text);
  if (sectionC === null) {
    return {
      ok: false,
      error: `No SECTION C header found in manual. First 1000 chars: ${raw.slice(0, 1000)}`,
    };
  }

  const clips = parseClipsFromDirectives(sectionC);
  if (clips.length === 0) {
    // Dump the body so the next failure shows EXACTLY what Claude emitted.
    console.log('[kling-manual] Section C body (first 2000 chars):', sectionC.slice(0, 2000));
    return {
      ok: false,
      error:
        `Section C has no [USE IMAGE X AS STARTING FRAME] directives. ` +
        `Claude likely formatted clips incorrectly. Section C first 2000 chars: ` +
        sectionC.slice(0, 2000),
    };
  }

  const blank = clips.findIndex((c) => !c.videoPrompt.trim());
  if (blank >= 0) {
    return { ok: false, error: `Clip ${blank + 1} has an empty video prompt` };
  }

  console.log(`[kling-manual] extracted ${clips.length} clips with directives.`);
  return { ok: true, manual: { characterPrompt, setPrompt, imageGuidance, clips } };
}

function errorWithExcerpt(prefix: string, raw: string, n: number): string {
  return `${prefix}. First ${n} chars: ${raw.slice(0, n)}`;
}

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:markdown|md)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

/** Slice `SECTION X — title\n...` up to next `SECTION Y` or EOF. */
function sliceSection(text: string, letter: 'A' | 'B' | 'C'): string {
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:#{0,6}\\s*)?SECTION\\s+${letter}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\n\\s*(?:#{0,6}\\s*)?SECTION\\s+[A-Z]\\b|$)`,
    'i',
  );
  const m = text.match(re);
  return m && m[1] ? m[1].trim() : '';
}

/**
 * Like sliceSection('C') but distinguishes "absent" from "empty". The
 * worker needs to surface a specific "no SECTION C header" error when
 * Claude omits the section entirely.
 */
function sliceSectionC(text: string): string | null {
  const re =
    /(?:^|\n)\s*(?:#{0,6}\s*)?SECTION\s+C\b[^\n]*\n([\s\S]*?)(?=\n\s*(?:#{0,6}\s*)?SECTION\s+[D-Z]\b|$)/i;
  const m = text.match(re);
  if (!m) return null;
  return (m[1] ?? '').trim();
}

/** Extract `Global <Kind> Prompt: <value>` (with or without **bold**). */
function extractGlobalPrompt(sectionA: string, kind: 'Character' | 'Set'): string {
  if (!sectionA) return '';
  const re = new RegExp(
    `(?:^|\\n)\\s*\\**\\s*Global\\s+${kind}\\s+Prompt\\s*\\**\\s*:\\s*\\**\\s*` +
      `([\\s\\S]+?)(?=\\n\\s*\\**\\s*Global\\s+\\w+\\s+Prompt\\s*\\**\\s*:|\\n\\s*(?:#+\\s*)?SECTION\\s+[A-Z]\\b|$)`,
    'i',
  );
  const m = sectionA.match(re);
  if (!m || !m[1]) return '';
  return m[1].replace(/\*\*/g, '').trim();
}

const USE_IMAGE_DIRECTIVE = /\[USE\s+IMAGE\s+(\d+)\s+AS\s+STARTING\s+FRAME\]/gi;

/**
 * Find every [USE IMAGE N AS STARTING FRAME] directive in Section C
 * body. Each directive starts a clip; body runs to the next directive.
 * Markdown decoration (### CLIP, **CLIP**, em-dashes, no header) is
 * ignored — the bracket directive is the sole anchor.
 *
 * Dedupe by image number (keep first), then sort ascending.
 */
function parseClipsFromDirectives(sectionC: string): ClipSpec[] {
  const re = new RegExp(USE_IMAGE_DIRECTIVE.source, 'gi');
  const anchors: { index: number; imageNum: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sectionC)) !== null) {
    anchors.push({ index: m.index, imageNum: Number(m[1]) });
  }
  if (anchors.length === 0) return [];

  const seen = new Set<number>();
  const clips: ClipSpec[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const cur = anchors[i]!;
    if (seen.has(cur.imageNum)) continue;
    seen.add(cur.imageNum);
    const next = anchors[i + 1];
    const body = sectionC.slice(cur.index, next ? next.index : sectionC.length).trim();

    const dialogue = extractDialogueDirective(body);
    const motionType = extractMotionTypeLine(body) || 'lip-sync';
    const duration = deriveDurationFromBody(body);

    clips.push({
      clipNumber: cur.imageNum,
      startingFrameImage: cur.imageNum,
      videoPrompt: body,
      dialogue: dialogue || undefined,
      duration,
      motionType,
      imagePrompt: undefined,
    });
  }
  clips.sort((a, b) => a.clipNumber - b.clipNumber);
  return clips;
}

function extractDialogueDirective(body: string): string {
  const m = body.match(/\[GENERATE\s+NATIVE\s+AUDIO[^\]]*\]:\s*"([^"]*)"/i);
  return m && m[1] ? m[1] : '';
}

function extractMotionTypeLine(body: string): string {
  const m = body.match(/(?:^|\n)\s*\**\s*motion[\s_-]?type\s*\**\s*:?\s*\**\s*([^\n]+)/i);
  if (!m || !m[1]) return '';
  return m[1]
    .replace(/\*\*/g, '')
    .replace(/[─━–—=_-]{4,}\s*$/, '')
    .trim();
}

function deriveDurationFromBody(body: string): number | undefined {
  // E.g. "00:00–00:06" or "00:00-00:06" in the header line within the body.
  const m = body.match(/(\d+):(\d+)\s*[–\-—]\s*(\d+):(\d+)/);
  if (!m || !m[1] || !m[2] || !m[3] || !m[4]) return undefined;
  const startSec = Number(m[1]) * 60 + Number(m[2]);
  const endSec = Number(m[3]) * 60 + Number(m[4]);
  const diff = endSec - startSec;
  return diff > 0 && diff <= 30 ? diff : undefined;
}

/**
 * Build the per-clip Nano Banana prompt. If the parser populated a
 * clip-specific image prompt (legacy path), use that directly.
 * Otherwise: character + set + Section B imageGuidance + clip's
 * videoPrompt — the master-prompt-defined image context plus this
 * clip's directive body, so the first frame matches the scene and
 * action Kling will animate.
 */
export function buildImagePromptForClip(
  manual: { characterPrompt: string; setPrompt: string; imageGuidance?: string },
  clip: ClipSpec,
): string {
  if (clip.imagePrompt && clip.imagePrompt.trim()) {
    return clip.imagePrompt;
  }
  return [manual.characterPrompt, manual.setPrompt, manual.imageGuidance, clip.videoPrompt]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .join('\n\n');
}

void logAuditEvent;
