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
  /** 1-indexed clip number from the `CLIP N — ...` header. */
  clipNumber: number;
  videoPrompt: string;
  dialogue?: string;
  duration?: number;
  /**
   * Nano Banana prompt for this clip's first frame — pulled from
   * Section B's master image prompt or per-image continuation. Worker
   * falls back to character+videoPrompt when undefined.
   */
  imagePrompt?: string;
  /** Image index this clip animates from, e.g. 1 from "Starting Frame: Image 1". */
  startingFrameImage?: number;
  motionType?: string;
}

interface ProductionManual {
  characterPrompt: string;
  setPrompt: string;
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
 * Polish-9.9: parse the Universal UGC Master Prompt's actual output
 * format. The spec at packages/ai-providers/src/prompts/master/
 * universal-ugc-master-prompt.md defines a separator-delimited block
 * structure in Section C — NOT a `### Clip N` + `**Field:**` form.
 *
 *   ─────────────────────────────────────────
 *   CLIP 1 — 00:00–00:06 — TITLE        ← or SCENE 1 (master prompt uses SCENE)
 *   Starting Frame: Image 1
 *   Last Frame needed: YES
 *   ─────────────────────────────────────────
 *   [USE IMAGE 1 AS STARTING FRAME]
 *   Subject: NAME, ref: 000, ...
 *   [GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "..."
 *   Static iPhone shot. ...
 *   ─────────────────────────────────────────
 *   motionType: lip-sync
 *
 * The prompt body (between separators 2 and 3) becomes videoPrompt
 * verbatim — Kling 3.0's prompting expects the [USE IMAGE X] anchor,
 * Subject ref, and [GENERATE NATIVE AUDIO...] directives intact.
 *
 * JSON fallback dropped: the master prompt never asks for JSON.
 */
export function parseProductionManual(
  raw: unknown,
): { ok: true; manual: ProductionManual } | { ok: false; error: string } {
  if (raw == null || typeof raw !== 'string') {
    return { ok: false, error: 'Claude returned no text for the manual.' };
  }

  const manual = parseFromMarkdown(raw);

  if (!manual.characterPrompt.trim()) {
    return { ok: false, error: errorWithExcerpt('Manual is missing characterPrompt', raw) };
  }
  if (!manual.setPrompt.trim()) {
    return { ok: false, error: errorWithExcerpt('Manual is missing setPrompt', raw) };
  }
  if (manual.clips.length === 0) {
    return {
      ok: false,
      error: errorWithExcerpt(
        'Manual Section C contained 0 parseable clip blocks (expected ───── separator blocks with CLIP/SCENE N headers)',
        raw,
      ),
    };
  }
  const blankClip = manual.clips.findIndex((c) => !c.videoPrompt.trim());
  if (blankClip >= 0) {
    return { ok: false, error: `Clip ${blankClip + 1} has an empty video prompt` };
  }
  return { ok: true, manual };
}

function errorWithExcerpt(prefix: string, raw: string): string {
  return `${prefix}. First 500 chars: ${raw.slice(0, 500)}`;
}

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:markdown|md)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

function parseFromMarkdown(text: string): ProductionManual {
  const cleaned = stripCodeFences(text);
  const sectionA = sliceSection(cleaned, 'A');
  const sectionB = sliceSection(cleaned, 'B');
  const sectionC = sliceSection(cleaned, 'C');

  const characterPrompt = extractGlobalPrompt(sectionA, 'Character');
  const setPrompt = extractGlobalPrompt(sectionA, 'Set');

  const masterImagePrompt = extractMasterImagePrompt(sectionB);
  const perImagePrompts = parsePerImageContinuations(sectionB);

  const clips = sectionC
    ? parseClipsFromSectionC(sectionC, { masterImagePrompt, perImagePrompts })
    : [];
  clips.sort((a, b) => (a.clipNumber ?? 0) - (b.clipNumber ?? 0));

  return { characterPrompt, setPrompt, clips };
}

/** Slice `SECTION X — title\n...` up to next `SECTION Y` or EOF. */
function sliceSection(text: string, letter: 'A' | 'B' | 'C'): string {
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:#+\\s*)?SECTION\\s+${letter}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\n\\s*(?:#+\\s*)?SECTION\\s+[A-Z]\\b|$)`,
    'i',
  );
  const m = text.match(re);
  return m && m[1] ? m[1].trim() : '';
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

const SEPARATOR_LINE = /^[─━–—=_-]{5,}\s*$/;

/**
 * Parse Section C clip blocks. Strategy:
 *   1. Find every line matching `(CLIP|SCENE) N — ...` — that's a clip
 *      header.
 *   2. For each header, take everything from this header to the next
 *      header (or EOF). That's the full clip block — header lines,
 *      separator rules, prompt body, and trailing motionType: line.
 *   3. The Kling video prompt body lives between the FIRST separator
 *      AFTER the header and the NEXT separator. Falls back to "every
 *      line not in the header zone or trailer" when separators are
 *      absent.
 */
function parseClipsFromSectionC(
  sectionC: string,
  imageContext: { masterImagePrompt: string; perImagePrompts: Record<number, string> },
): ClipSpec[] {
  const headerRe = /(?:^|\n)\s*(?:#+\s*)?(?:CLIP|SCENE|Clip|Scene)\s+(\d+)\s*[—\-–]/g;
  const headers: { startInBlock: number; clipNum: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(sectionC)) !== null) {
    headers.push({
      startInBlock: m.index + (m[0].startsWith('\n') ? 1 : 0),
      clipNum: Number(m[1]),
    });
  }
  if (headers.length === 0) return [];

  const clips: ClipSpec[] = [];
  for (let i = 0; i < headers.length; i++) {
    const cur = headers[i]!;
    const next = headers[i + 1];
    const block = sectionC.slice(cur.startInBlock, next ? next.startInBlock : sectionC.length);

    const startingFrameImage = extractStartingFrame(block) ?? cur.clipNum;
    const dialogue = extractBracketedDialogue(block);
    const motionType = extractMotionTypeLine(block);
    const duration = deriveDurationFromHeader(block);
    const videoPrompt = extractClipBody(block);

    const imagePrompt =
      imageContext.perImagePrompts[startingFrameImage] ??
      imageContext.masterImagePrompt ??
      undefined;

    clips.push({
      clipNumber: cur.clipNum,
      startingFrameImage,
      videoPrompt: videoPrompt.trim(),
      dialogue: dialogue || undefined,
      duration,
      imagePrompt: imagePrompt && imagePrompt.trim() ? imagePrompt.trim() : undefined,
      motionType: motionType || undefined,
    });
  }
  return clips;
}

function extractStartingFrame(block: string): number | undefined {
  const m = block.match(/Starting\s+Frame:\s*Image\s*(\d+)/i);
  return m && m[1] ? Number(m[1]) : undefined;
}

function extractBracketedDialogue(block: string): string {
  const m = block.match(
    /\[GENERATE\s+NATIVE\s+AUDIO\s+AND\s+LIP-?SYNC\s+TO\s+EXACT\s+DIALOGUE\]:\s*"([^"]+)"/i,
  );
  return m && m[1] ? m[1] : '';
}

function extractMotionTypeLine(block: string): string {
  const m = block.match(/(?:^|\n)\s*motion[\s_-]?type\s*:?\s*([^\n]+)/i);
  if (!m || !m[1]) return '';
  return m[1]
    .replace(/\*\*/g, '')
    .replace(/[─━–—=_-]{4,}\s*$/, '')
    .trim();
}

function deriveDurationFromHeader(block: string): number | undefined {
  // CLIP 1 — 00:00–00:06 — HOOK  →  6 seconds
  const m = block.match(/(\d+):(\d+)\s*[–\-—]\s*(\d+):(\d+)/);
  if (!m || !m[1] || !m[2] || !m[3] || !m[4]) return undefined;
  const startSec = Number(m[1]) * 60 + Number(m[2]);
  const endSec = Number(m[3]) * 60 + Number(m[4]);
  const diff = endSec - startSec;
  return diff > 0 && diff <= 30 ? diff : undefined;
}

/**
 * Extract the Kling prompt body — the [USE IMAGE X], Subject, [GENERATE
 * NATIVE AUDIO...], action-text region between separators 2 and 3 of
 * the master-prompt format. Sent to Kling verbatim because its prompt
 * grammar expects those bracket directives.
 *
 * Fallback when separators are absent: drop the header + Starting
 * Frame / Last Frame / motionType lines, keep the rest.
 */
function extractClipBody(block: string): string {
  const lines = block.split('\n');
  const sepIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (SEPARATOR_LINE.test(lines[i]!)) sepIndexes.push(i);
  }

  if (sepIndexes.length >= 2) {
    // The standard 3-separator layout: header zone between 0..sep[0],
    // body between sep[0]+1..sep[1], trailer (motionType) after sep[1].
    return lines
      .slice(sepIndexes[0]! + 1, sepIndexes[1]!)
      .join('\n')
      .trim();
  }
  if (sepIndexes.length === 1) {
    // Forge-truncated form with just one separator after the header.
    return lines
      .slice(sepIndexes[0]! + 1)
      .filter((l) => !/^\s*motion[\s_-]?type\s*:/i.test(l))
      .join('\n')
      .trim();
  }
  // No separators — strip the header + frame metadata + motionType, keep rest.
  return lines
    .filter((l) => {
      if (/^\s*(?:#+\s*)?(?:CLIP|SCENE|Clip|Scene)\s+\d+\s*[—\-–]/.test(l)) return false;
      if (/^\s*Starting\s+Frame:/i.test(l)) return false;
      if (/^\s*Last\s+Frame\s+needed:/i.test(l)) return false;
      if (/^\s*motion[\s_-]?type\s*:/i.test(l)) return false;
      if (SEPARATOR_LINE.test(l)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

/**
 * Pull the IMAGE 1 — Master First Frame block from Section B. Used as
 * the fallback Nano Banana prompt when per-clip continuations aren't
 * parseable.
 */
function extractMasterImagePrompt(sectionB: string): string {
  if (!sectionB) return '';
  const re =
    /(?:^|\n)\s*(?:#+\s*)?(?:IMAGE|Image)\s+1\b[^\n]*\n([\s\S]+?)(?=\n\s*(?:#+\s*)?(?:IMAGE|Image)S?\b|$)/i;
  const m = sectionB.match(re);
  return m && m[1] ? m[1].trim() : '';
}

/**
 * Best-effort: pull per-image continuation snippets from a Forge-style
 * Section B "IMAGES 2–16 — Same-Scene Continuations" table where each
 * record is a numeric line followed by 1-2 description lines. Returns
 * a sparse map keyed by image number; absent keys fall back to the
 * master prompt at the caller.
 */
function parsePerImageContinuations(sectionB: string): Record<number, string> {
  const out: Record<number, string> = {};
  if (!sectionB) return out;
  const contMatch = sectionB.match(
    /(?:IMAGES?|Images?)\s+[\d–\-—\s]+[—\-:][^\n]*(?:Continuations?|Same.?Scene)[^\n]*\n([\s\S]+)$/i,
  );
  if (!contMatch || !contMatch[1]) return out;
  const lines = contMatch[1]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  let i = 0;
  while (i < lines.length) {
    const numMatch = lines[i]!.match(/^(\d{1,2})$/);
    if (!numMatch) {
      i += 1;
      continue;
    }
    const num = Number(numMatch[1]);
    const desc1 = lines[i + 1];
    const desc2 = lines[i + 2];
    const parts: string[] = [];
    if (desc1 && !/^\d{1,2}$/.test(desc1)) parts.push(desc1);
    if (desc2 && !/^\d{1,2}$/.test(desc2)) parts.push(desc2);
    if (parts.length === 0 || num < 2 || num > 99) {
      i += 1;
      continue;
    }
    out[num] = parts.join('. ');
    i += 1 + parts.length;
  }
  return out;
}

/**
 * Build the per-clip Nano Banana prompt. If the parser found a
 * clip-specific image prompt (master first-frame or per-image
 * continuation), use that directly. Otherwise use the Section A
 * character prompt + the clip's video prompt as scene context so
 * Nano Banana still has something coherent to render.
 */
export function buildImagePromptForClip(
  manual: { characterPrompt: string; setPrompt: string },
  clip: ClipSpec,
): string {
  if (clip.imagePrompt && clip.imagePrompt.trim()) {
    return clip.imagePrompt;
  }
  return [manual.characterPrompt, clip.videoPrompt]
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .join('\n\n');
}

void logAuditEvent;
