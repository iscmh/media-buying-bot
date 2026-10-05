'use server';

import { Buffer } from 'node:buffer';
import {
  checkHeygenAvatarIvStatus,
  cloneCharacterReferenceImage,
  composeNanoBananaCharacterClonePrompt,
  fetchHeygenVoices,
  matchHeygenVoiceForPersona,
  submitHeygenAvatarIvGeneration,
  uploadHeygenImageAsset,
  type HeygenVoice,
} from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { decryptSecret } from '@mbb/db';
import { requireAdmin } from '@/lib/admin-gate';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * Polish-30.0.15 Commit 187: admin-only raw UGC generator rewired to
 * the Avatar IV + Nano Banana Pro flow. The pre-Polish-27 version
 * targeted MakeUGC which is deprecated; this version mirrors what
 * polish28_variations_ugc does per-variant but drives the inputs
 * (persona + script) from the admin's form instead of a Claude batch.
 *
 * Flow:
 *   1. Admin picks persona (gender, age bucket, ethnicity, look text) and
 *      writes a script.
 *   2. Server action loads admin's own BYOK (Gemini + HeyGen) from the
 *      right table — gemini lives in tool_connections, heygen lives in
 *      ai_provider_connections (same split loadDecryptedKeys uses).
 *   3. Nano Banana Pro renders a character still from persona.look.
 *   4. Upload still to HeyGen as asset_id.
 *   5. Fetch HeyGen voice roster → matchHeygenVoiceForPersona scores and
 *      picks a voice (same scoring matcher as the automated pipeline).
 *   6. Submit Avatar IV with image_key + script + voice_id.
 *   7. Return video_id.
 *
 * Client polls checkRawUgcStatusAction every ~5s until completed/failed.
 */

async function loadGeminiKey(userId: string): Promise<string> {
  const db = getDb();
  const row = await db.query.toolConnections.findFirst({
    where: and(
      eq(schema.toolConnections.userId, userId),
      eq(schema.toolConnections.provider, 'gemini'),
      eq(schema.toolConnections.status, 'active'),
      isNull(schema.toolConnections.deletedAt),
    ),
    columns: { apiKeyEncrypted: true },
  });
  if (!row?.apiKeyEncrypted) {
    throw new Error('No Gemini key connected. Connect at /settings/connections.');
  }
  const decrypted = await decryptSecret(row.apiKeyEncrypted);
  if (!decrypted?.trim()) throw new Error('Decrypted Gemini key is empty.');
  return decrypted;
}

async function loadHeygenKey(userId: string): Promise<string> {
  const db = getDb();
  const row = await db.query.aiProviderConnections.findFirst({
    where: and(
      eq(schema.aiProviderConnections.userId, userId),
      eq(schema.aiProviderConnections.provider, 'heygen'),
      eq(schema.aiProviderConnections.status, 'active'),
      isNull(schema.aiProviderConnections.deletedAt),
    ),
    columns: { apiKeyEncrypted: true },
  });
  if (!row?.apiKeyEncrypted) {
    throw new Error('No HeyGen key connected. Connect at /settings/connections.');
  }
  const decrypted = await decryptSecret(row.apiKeyEncrypted);
  if (!decrypted?.trim()) throw new Error('Decrypted HeyGen key is empty.');
  return decrypted;
}

export interface SubmitRawUgcInput {
  gender: 'male' | 'female';
  ageRange: string;
  ethnicity: string;
  look: string;
  script: string;
  videoName?: string;
}

export interface SubmitRawUgcResult {
  ok: boolean;
  videoId?: string;
  characterUrl?: string;
  voiceName?: string;
  errorMessage?: string;
}

/**
 * Fire the full character-generate + voice-match + Avatar IV submit
 * chain. Returns quickly with the HeyGen video_id; client polls
 * checkRawUgcStatusAction every few seconds until completed.
 */
export async function submitRawUgcAction(input: SubmitRawUgcInput): Promise<SubmitRawUgcResult> {
  const { userId } = await requireAdmin();

  if (!input.gender || !input.ageRange || !input.ethnicity) {
    return { ok: false, errorMessage: 'Fill gender, age, and ethnicity.' };
  }
  if (!input.look?.trim()) return { ok: false, errorMessage: 'Describe the look.' };
  if (!input.script?.trim()) return { ok: false, errorMessage: 'Script is empty.' };

  let geminiKey: string;
  let heygenKey: string;
  try {
    [geminiKey, heygenKey] = await Promise.all([loadGeminiKey(userId), loadHeygenKey(userId)]);
  } catch (err) {
    return { ok: false, errorMessage: err instanceof Error ? err.message : String(err) };
  }

  // 1. Nano Banana Pro character still from persona.look
  let characterBase64: string;
  let characterMime: string;
  try {
    const personaText =
      `Age: ${input.ageRange}. Gender: ${input.gender}. ` +
      `Ethnicity: ${input.ethnicity}. Look: ${input.look.trim()}`;
    const prompt = composeNanoBananaCharacterClonePrompt(personaText);
    const grayPixelPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const r = await cloneCharacterReferenceImage({
      userId,
      apiKey: geminiKey,
      prompt,
      referenceImageBase64: grayPixelPngBase64,
      referenceImageMimeType: 'image/png',
    });
    if (!r.ok || !r.imageBase64) {
      return {
        ok: false,
        errorMessage: `Character gen failed: ${r.errorMessage ?? 'unknown Nano Banana error'}`,
      };
    }
    characterBase64 = r.imageBase64;
    characterMime = r.imageMimeType ?? 'image/png';
  } catch (err) {
    return {
      ok: false,
      errorMessage: `Character gen crashed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 2. Upload character to HeyGen as asset
  let imageKey: string;
  try {
    const bytes = new Uint8Array(Buffer.from(characterBase64, 'base64'));
    const normalizedMime =
      characterMime === 'image/jpeg' || characterMime === 'image/jpg' ? 'image/jpeg' : 'image/png';
    const r = await uploadHeygenImageAsset({
      userId,
      apiKey: heygenKey,
      imageBytes: bytes,
      imageMimeType: normalizedMime,
    });
    if (!r.ok || !r.imageKey) {
      return {
        ok: false,
        errorMessage: `HeyGen asset upload failed: ${r.errorMessage ?? 'unknown'}`,
      };
    }
    imageKey = r.imageKey;
  } catch (err) {
    return {
      ok: false,
      errorMessage: `HeyGen upload crashed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 3. Fetch HeyGen voice roster + match persona
  let matchedVoice: HeygenVoice;
  try {
    const fetched = await fetchHeygenVoices({ userId, apiKey: heygenKey });
    if (!fetched.ok || fetched.voices.length === 0) {
      return {
        ok: false,
        errorMessage: `HeyGen voice-list failed: ${fetched.errorMessage ?? 'no voices'}`,
      };
    }
    const personaSentence = `${input.ageRange} ${input.gender} ${input.ethnicity}. ${input.look.trim()}`;
    matchedVoice = matchHeygenVoiceForPersona(fetched.voices, personaSentence);
  } catch (err) {
    return {
      ok: false,
      errorMessage: `Voice match crashed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 4. Submit Avatar IV with image_key + script + voice_id
  try {
    const title = input.videoName?.trim() ?? `admin-raw-${new Date().toISOString().slice(0, 19)}`;
    const r = await submitHeygenAvatarIvGeneration({
      userId,
      apiKey: heygenKey,
      imageKey,
      script: input.script.trim(),
      voiceId: matchedVoice.voice_id,
      videoTitle: title,
    });
    if (!r.ok || !r.videoId) {
      return {
        ok: false,
        errorMessage: `HeyGen submit failed: ${r.errorMessage ?? 'no videoId'}`,
      };
    }
    return {
      ok: true,
      videoId: r.videoId,
      voiceName: matchedVoice.name,
    };
  } catch (err) {
    return {
      ok: false,
      errorMessage: `HeyGen submit crashed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface CheckRawUgcResult {
  ok: boolean;
  status: 'processing' | 'completed' | 'failed';
  videoUrl?: string;
  errorMessage?: string;
}

/**
 * Poll the Avatar IV job. Client calls this every ~5s until the
 * status flips to completed or failed.
 */
export async function checkRawUgcStatusAction(videoId: string): Promise<CheckRawUgcResult> {
  const { userId } = await requireAdmin();
  if (!videoId) return { ok: false, status: 'failed', errorMessage: 'Missing videoId.' };

  let heygenKey: string;
  try {
    heygenKey = await loadHeygenKey(userId);
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const r = await checkHeygenAvatarIvStatus({ userId, apiKey: heygenKey, videoId });
    if (!r.ok) {
      return {
        ok: false,
        status: 'failed',
        errorMessage: r.errorMessage ?? 'Status check returned not-ok.',
      };
    }
    const bucket: 'processing' | 'completed' | 'failed' =
      r.status === 'completed' ? 'completed' : r.status === 'failed' ? 'failed' : 'processing';
    return {
      ok: true,
      status: bucket,
      videoUrl: r.videoUrl ?? undefined,
      errorMessage: r.errorMessage ?? undefined,
    };
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
