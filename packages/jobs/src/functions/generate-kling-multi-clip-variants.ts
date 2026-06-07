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
      const parsed = parseProductionManual(claude.json ?? claude.text, {
        expectedClips: CLIPS_PER_VARIANT,
      });
      if (!parsed.ok) {
        console.log(`[kling-manual] parse failed: ${parsed.error}`);
        return { ok: false as const, error: parsed.error, costUsd: claude.costUsd };
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
  videoPrompt: string;
  dialogue?: string;
  duration?: number;
  imagePrompt?: string;
  motionType?: string;
}

interface ProductionManual {
  characterPrompt: string;
  setPrompt: string;
  clips: ClipSpec[];
}

interface ParseOptions {
  /**
   * Strict count check. The worker passes CLIPS_PER_VARIANT (16) so a
   * truncated Claude response surfaces as a clear "got N, expected 16"
   * error instead of a silently-short job.
   */
  expectedClips?: number;
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
 * Polish-9.8: parse the Universal UGC Master Prompt's output. The
 * master prompt specifies a structured markdown format (SECTION A / B
 * / C, Global Character Prompt, per-clip blocks) — NOT JSON. Polish-9.7
 * was wrong to hard-fail on non-JSON: Claude was correctly emitting
 * markdown per spec and the parser was looking at the wrong format.
 *
 * Order: try JSON first (backwards compat + cheap), fall back to the
 * markdown parser. Both must work — someone may later add an explicit
 * "respond as JSON" instruction without breaking existing runs.
 */
export function parseProductionManual(
  raw: unknown,
  options: ParseOptions = {},
): { ok: true; manual: ProductionManual } | { ok: false; error: string } {
  if (raw == null) {
    return { ok: false, error: 'Claude returned neither JSON nor text for the manual.' };
  }
  if (typeof raw === 'object') {
    return validateManual(parseFromJsonObject(raw as Record<string, unknown>), raw, options);
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Claude returned neither JSON nor text for the manual.' };
  }

  const text = raw;
  const stripped = stripCodeFences(text);
  if (stripped.startsWith('{') || stripped.startsWith('[')) {
    try {
      const json = JSON.parse(stripped) as Record<string, unknown>;
      return validateManual(parseFromJsonObject(json), json, options);
    } catch {
      // fall through to markdown
    }
  }
  return validateManual(parseFromMarkdown(text), text, options);
}

function validateManual(
  manual: ProductionManual,
  source: unknown,
  options: ParseOptions,
): { ok: true; manual: ProductionManual } | { ok: false; error: string } {
  if (!manual.characterPrompt.trim()) {
    return { ok: false, error: errorWithExcerpt('Manual is missing characterPrompt', source) };
  }
  if (!manual.setPrompt.trim()) {
    return { ok: false, error: errorWithExcerpt('Manual is missing setPrompt', source) };
  }
  if (manual.clips.length === 0) {
    return { ok: false, error: errorWithExcerpt('Manual has 0 clips', source) };
  }
  if (options.expectedClips != null && manual.clips.length !== options.expectedClips) {
    return {
      ok: false,
      error: `Manual has ${manual.clips.length} clips, expected ${options.expectedClips}`,
    };
  }
  const blankClip = manual.clips.findIndex((c) => !c.videoPrompt.trim());
  if (blankClip >= 0) {
    return { ok: false, error: `Clip ${blankClip + 1} has an empty video prompt` };
  }
  return { ok: true, manual };
}

function errorWithExcerpt(prefix: string, source: unknown): string {
  if (typeof source === 'string') {
    return `${prefix}. First 500 chars: ${source.slice(0, 500)}`;
  }
  return prefix;
}

function parseFromJsonObject(obj: Record<string, unknown>): ProductionManual {
  const characterPrompt = pickString(obj, ['character_prompt', 'characterPrompt']) ?? '';
  const setPrompt = pickString(obj, ['set_prompt', 'setPrompt']) ?? '';
  const rawClips = Array.isArray(obj.clips) ? obj.clips : [];
  const clips: ClipSpec[] = [];
  for (const item of rawClips) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const videoPrompt = pickString(c, ['video_prompt', 'videoPrompt', 'prompt']) ?? '';
    clips.push({
      videoPrompt,
      dialogue: pickString(c, ['dialogue']),
      duration: typeof c.duration === 'number' ? c.duration : undefined,
      imagePrompt: pickString(c, ['image_prompt', 'imagePrompt']),
      motionType: pickString(c, ['motion_type', 'motionType']),
    });
  }
  return { characterPrompt, setPrompt, clips };
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json|markdown|md)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

/**
 * Markdown parser for the master-prompt format. Tolerant of:
 *   - Plain `SECTION A` headers vs `## SECTION A`
 *   - Plain `Global Character Prompt:` vs `**Global Character Prompt:**`
 *   - `### Clip 1` / `**Video Prompt:**` (normalized) format
 *   - Forge-style `─────` separators + `CLIP 1 — 00:00–00:06 — TITLE`
 *     headers, with `[USE IMAGE X AS STARTING FRAME]` + `[GENERATE
 *     NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]: "..."` brackets
 */
function parseFromMarkdown(text: string): ProductionManual {
  const cleaned = stripCodeFences(text);
  const sectionA = sliceSection(cleaned, 'A');
  const sectionB = sliceSection(cleaned, 'B');
  const sectionC = sliceSection(cleaned, 'C');

  const characterPrompt = extractFieldValue(sectionA, 'Global Character Prompt');
  const setPrompt = extractFieldValue(sectionA, 'Global Set Prompt');

  const clipSource = sectionC || cleaned;
  const clipBlocks = splitClipBlocks(clipSource);
  const clips: ClipSpec[] = clipBlocks.map((block) =>
    parseClipBlock(block, sectionB, characterPrompt, setPrompt),
  );

  return { characterPrompt, setPrompt, clips };
}

/**
 * Slice the section starting at `SECTION X` (with or without leading
 * `#` markers) up to but not including the next `SECTION Y` or EOF.
 * Returns '' when the section is absent so callers can safely string-op.
 */
function sliceSection(text: string, letter: 'A' | 'B' | 'C'): string {
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:#+\\s*)?SECTION\\s+${letter}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\n\\s*(?:#+\\s*)?SECTION\\s+[A-Z]\\b|$)`,
    'i',
  );
  const m = text.match(re);
  return m && m[1] ? m[1].trim() : '';
}

/**
 * Extract a `Field Name: value` block, value running until the next
 * recognized field/section marker. Handles `**Field:** value`,
 * `Field: value`, and `### Field` (followed by value on next line).
 */
function extractFieldValue(scope: string, field: string): string {
  if (!scope) return '';
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:\\*\\*|#{1,6}\\s*)?${escaped}(?:\\*\\*)?\\s*:?\\s*\\*{0,2}\\s*\\n?` +
      `([\\s\\S]+?)(?=\\n\\s*(?:\\*\\*|#{1,6}\\s*)?` +
      `(?:Global \\w+ Prompt|Image Prompt|Video Prompt|Dialogue|Duration|Motion ?Type|motionType|Starting Frame|Last Frame|SECTION\\s+[A-Z]|CLIP\\s+\\d|Clip\\s+\\d)` +
      `|\\n\\s*[─=\\-]{4,}` +
      `|$)`,
    'i',
  );
  const m = scope.match(re);
  if (!m || !m[1]) return '';
  return m[1]
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/[─=-]{4,}\s*$/g, '')
    .trim();
}

/**
 * Split Section C (or whole doc) into clip blocks. A clip header is any
 * of: `### Clip N`, `## CLIP N`, or `CLIP N — timestamp — title`.
 */
function splitClipBlocks(text: string): string[] {
  if (!text) return [];
  const headerRe = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:CLIP|Clip)\s+(\d+)\b/g;
  const matches: { index: number; clipNum: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(text)) !== null) {
    matches.push({ index: m.index, clipNum: Number(m[1]) });
  }
  if (matches.length === 0) return [];
  const blocks: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]!;
    const next = matches[i + 1];
    const start = cur.index;
    const end = next ? next.index : text.length;
    blocks.push(text.slice(start, end));
  }
  return blocks;
}

function parseClipBlock(
  block: string,
  sectionB: string,
  characterPrompt: string,
  setPrompt: string,
): ClipSpec {
  const headerMatch = block.match(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:CLIP|Clip)\s+(\d+)/);
  const clipNum = headerMatch ? Number(headerMatch[1]) : 0;

  const explicitVideoPrompt = extractFieldValue(block, 'Video Prompt');
  const explicitImagePrompt = extractFieldValue(block, 'Image Prompt');
  const explicitDialogue = extractFieldValue(block, 'Dialogue');
  const explicitDuration = extractFieldValue(block, 'Duration');
  const explicitMotion =
    extractFieldValue(block, 'Motion Type') || extractFieldValue(block, 'motionType');

  const dialogue = explicitDialogue || extractBracketedDialogue(block);
  const duration = parseDurationNumber(explicitDuration) ?? deriveDurationFromHeader(block);
  const videoPrompt =
    explicitVideoPrompt || extractClipBodyAsPrompt(block, characterPrompt, setPrompt);
  const imagePrompt =
    explicitImagePrompt || (clipNum > 0 ? sliceImagePromptFromSectionB(sectionB, clipNum) : '');

  return {
    videoPrompt: stripQuotes(videoPrompt),
    dialogue: dialogue ? stripQuotes(dialogue) : undefined,
    duration,
    imagePrompt: imagePrompt || undefined,
    motionType: explicitMotion || undefined,
  };
}

function extractBracketedDialogue(block: string): string {
  const m = block.match(/\[GENERATE NATIVE AUDIO AND LIP-?SYNC TO EXACT DIALOGUE\]:\s*"([^"]+)"/i);
  return m && m[1] ? m[1] : '';
}

function parseDurationNumber(raw: string): number | undefined {
  if (!raw) return undefined;
  const m = raw.match(/(\d+(?:\.\d+)?)\s*s?/);
  return m && m[1] ? Number(m[1]) : undefined;
}

function deriveDurationFromHeader(block: string): number | undefined {
  // CLIP 1 — 00:00–00:06 — HOOK  →  6 seconds
  const m = block.match(/(\d+):(\d+)[–\-—](\d+):(\d+)/);
  if (!m || !m[1] || !m[2] || !m[3] || !m[4]) return undefined;
  const startSec = Number(m[1]) * 60 + Number(m[2]);
  const endSec = Number(m[3]) * 60 + Number(m[4]);
  const diff = endSec - startSec;
  return diff > 0 && diff <= 30 ? diff : undefined;
}

/**
 * When the clip has no explicit `**Video Prompt:**` marker (Forge-style
 * output), use the block body itself as the Kling prompt. Strips the
 * header, separator lines, `motionType:` trailer, and `**Field:**`
 * scaffolding so Kling gets clean instruction text.
 */
function extractClipBodyAsPrompt(
  block: string,
  characterPrompt: string,
  setPrompt: string,
): string {
  const body = block
    .replace(/^[^\n]*\n/, '') // drop the header line
    .replace(/^[─=-]{4,}\s*$/gm, '') // separator rules
    .replace(/^Starting Frame:[^\n]*$/gim, '')
    .replace(/^Last Frame needed:[^\n]*$/gim, '')
    .replace(/^motionType:[^\n]*$/gim, '')
    .replace(/^\*\*Motion Type:\*\*[^\n]*$/gim, '')
    .replace(/^\*\*Duration:\*\*[^\n]*$/gim, '')
    .trim();
  if (body) return body;
  // Last-resort fallback so Kling still gets a coherent prompt.
  return [characterPrompt, setPrompt].filter((s) => s.trim()).join('\n\n');
}

/**
 * Try to pull `IMAGE N` (or `Image N`) prompt text out of Section B.
 * Forge uses `IMAGE 1 — Master First Frame:` followed by the full
 * paragraph, then a same-scene continuation table for 2-16. We return
 * the IMAGE 1 prompt for clip 1; for clips 2+ we return '' so the
 * worker falls back to character+set+videoPrompt — which is fine
 * because Nano Banana anchors on whatever scene description it gets.
 */
function sliceImagePromptFromSectionB(sectionB: string, clipNum: number): string {
  if (!sectionB || clipNum < 1) return '';
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:IMAGE|Image)\\s+${clipNum}\\b[^\\n]*\\n([\\s\\S]+?)` +
      `(?=\\n\\s*(?:#{1,6}\\s*)?(?:IMAGE|Image)\\s+\\d|\\n\\s*(?:#{1,6}\\s*)?SECTION|$)`,
    'i',
  );
  const m = sectionB.match(re);
  return m && m[1] ? m[1].trim() : '';
}

function stripQuotes(s: string): string {
  return s
    .trim()
    .replace(/^["'`]+/, '')
    .replace(/["'`]+$/, '')
    .trim();
}

/**
 * Build the per-clip Nano Banana prompt. Combines character + set +
 * clip-specific image prompt (if extracted) + dialogue context so the
 * first frame matches the scene + action that Kling will animate.
 */
export function buildImagePromptForClip(
  manual: { characterPrompt: string; setPrompt: string },
  clip: ClipSpec,
): string {
  const parts = [
    manual.characterPrompt,
    manual.setPrompt,
    clip.imagePrompt,
    clip.videoPrompt,
  ].filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  return parts.join('\n\n');
}

void logAuditEvent;
