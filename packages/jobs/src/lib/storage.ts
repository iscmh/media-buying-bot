import { createClient } from '@supabase/supabase-js';

/**
 * Service-role Supabase client for Inngest job use. Runs from a trusted
 * server context (Inngest worker), bypasses RLS, can read/write any
 * user's storage objects.
 *
 * Keep usage scoped — every call should pass an explicit user_id-prefixed
 * path so we don't accidentally cross-tenant in code.
 */
export function getServiceRoleSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Service-role Supabase client requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY',
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Download a file from Supabase Storage and return base64 + mime type.
 * Used by analyze-concept for video → Gemini Vision.
 *
 * Caller passes `maxBytes` as a defense-in-depth cap (post Phase 3h,
 * 2 GB to match the Gemini Files API ceiling — callGeminiVision routes
 * inline ≤ 20 MB and Files API for everything larger).
 */
export async function downloadAsBase64(input: {
  bucket: string;
  path: string;
  maxBytes?: number;
}): Promise<{ base64: string; mimeType: string; sizeBytes: number }> {
  const supabase = getServiceRoleSupabase();
  const { data, error } = await supabase.storage.from(input.bucket).download(input.path);
  if (error) {
    throw new Error(`Storage download failed for ${input.bucket}/${input.path}: ${error.message}`);
  }
  if (!data) {
    throw new Error(`Storage returned no data for ${input.bucket}/${input.path}`);
  }
  const mimeType = data.type || 'application/octet-stream';
  const buffer = Buffer.from(await data.arrayBuffer());
  if (input.maxBytes != null && buffer.byteLength > input.maxBytes) {
    throw new Error(
      `File ${input.path} is ${buffer.byteLength} bytes; max allowed is ${input.maxBytes}`,
    );
  }
  return { base64: buffer.toString('base64'), mimeType, sizeBytes: buffer.byteLength };
}

/**
 * Upload base64 image data to Supabase Storage at the user-scoped path
 * `<userId>/generated/<jobId>/<variantIndex>.png`. Returns both the
 * object path (for backend ops like deletion) and the public URL (for
 * the UI). The `generated-creatives` bucket is public; if it ever needs
 * to go private, swap getPublicUrl() for createSignedUrl().
 */
export async function uploadGeneratedImage(input: {
  userId: string;
  jobId: string;
  variantIndex: number;
  imageBase64: string;
  mimeType: string;
  /**
   * Polish-9.8: optional prefix so the Kling pipeline's per-clip first-
   * frame uploads (`kling-frame-0`, `kling-frame-1`, …) don't collide
   * with the static-image pipeline's `0`, `1`, … variant filenames.
   */
  filenamePrefix?: string;
}): Promise<{ path: string; publicUrl: string }> {
  const supabase = getServiceRoleSupabase();
  const ext = input.mimeType === 'image/jpeg' ? '.jpg' : '.png';
  const stem = input.filenamePrefix
    ? `${input.filenamePrefix}${input.variantIndex}`
    : `${input.variantIndex}`;
  const path = `${input.userId}/generated/${input.jobId}/${stem}${ext}`;
  const buffer = Buffer.from(input.imageBase64, 'base64');
  const { error } = await supabase.storage
    .from('generated-creatives')
    .upload(path, buffer, { contentType: input.mimeType, upsert: true });
  if (error) {
    throw new Error(`Storage upload failed for ${path}: ${error.message}`);
  }
  const { data } = supabase.storage.from('generated-creatives').getPublicUrl(path);
  return { path, publicUrl: data.publicUrl };
}

/**
 * Polish-9.12: download a previously-uploaded image from the
 * generated-creatives bucket back to base64 so subsequent Nano Banana
 * calls can pass it as a reference image (character anchor chain).
 *
 * Path convention matches uploadGeneratedImage: `<userId>/generated/
 * <jobId>/<stem>.<ext>` — we accept the same shape and rebuild the
 * path so the caller doesn't need to remember the layout.
 */
export async function downloadGeneratedImageAsBase64(input: {
  userId: string;
  jobId: string;
  variantIndex: number;
  filenamePrefix?: string;
  mimeType?: string;
}): Promise<{ base64: string; mimeType: string }> {
  const ext = input.mimeType === 'image/jpeg' ? '.jpg' : '.png';
  const stem = input.filenamePrefix
    ? `${input.filenamePrefix}${input.variantIndex}`
    : `${input.variantIndex}`;
  const path = `${input.userId}/generated/${input.jobId}/${stem}${ext}`;
  return downloadAsBase64({ bucket: 'generated-creatives', path });
}

/**
 * Polish-12: fetch a remote MP4 (kie.ai CDN, Replicate delivery, etc.)
 * and re-upload to the user-scoped generated-creatives bucket so the
 * deliverable has a durable URL that won't expire when the upstream
 * model provider rotates its hosting. Returns the path + public URL.
 *
 * Polish-19.2.4: added `fetchHeaders` for providers whose output URIs
 * require auth (Veo 3.1 returns a generativelanguage.googleapis.com
 * Files API URL that 403s without the same x-goog-api-key the submit
 * call used). The helper stays provider-agnostic — caller decides
 * which headers to attach. Once the file lands in Supabase Storage
 * the public URL is permanent; this is the only moment the upstream
 * key matters.
 */
export async function uploadGeneratedVideoFromUrl(input: {
  userId: string;
  jobId: string;
  remoteUrl: string;
  filename?: string;
  maxBytes?: number;
  /** Headers forwarded to the upstream GET. Use for Files-API-style private URIs. */
  fetchHeaders?: Record<string, string>;
}): Promise<{ path: string; publicUrl: string; sizeBytes: number }> {
  const supabase = getServiceRoleSupabase();
  const stem = input.filename ?? 'output';
  const path = `${input.userId}/generated/${input.jobId}/${stem}.mp4`;
  let res: Response;
  try {
    res = await fetch(input.remoteUrl, { headers: input.fetchHeaders });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Remote video fetch failed for ${input.remoteUrl}: ${msg}`);
  }
  if (!res.ok) {
    throw new Error(`Remote video fetch failed: HTTP ${res.status} for ${input.remoteUrl}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (input.maxBytes != null && buffer.byteLength > input.maxBytes) {
    throw new Error(
      `Remote video ${input.remoteUrl} is ${buffer.byteLength} bytes; max allowed is ${input.maxBytes}`,
    );
  }
  const { error } = await supabase.storage
    .from('generated-creatives')
    .upload(path, buffer, { contentType: 'video/mp4', upsert: true });
  if (error) {
    throw new Error(`Video upload failed for ${path}: ${error.message}`);
  }
  const { data } = supabase.storage.from('generated-creatives').getPublicUrl(path);
  return { path, publicUrl: data.publicUrl, sizeBytes: buffer.byteLength };
}

/**
 * Polish-11: upload an ElevenLabs MP3 to the generated-creatives
 * bucket so the Replicate lipsync model can fetch it via public URL.
 * Path mirrors uploadGeneratedImage but with an audio-specific stem
 * and configurable extension. Returns the public URL for direct
 * use in the lipsync submit body.
 */
export async function uploadGeneratedAudio(input: {
  userId: string;
  jobId: string;
  audioBase64: string;
  mimeType: string;
  filename?: string;
}): Promise<{ path: string; publicUrl: string }> {
  const supabase = getServiceRoleSupabase();
  const ext = input.mimeType === 'audio/mpeg' || input.mimeType === 'audio/mp3' ? '.mp3' : '.wav';
  const stem = input.filename ?? 'voiceover';
  const path = `${input.userId}/generated/${input.jobId}/${stem}${ext}`;
  const buffer = Buffer.from(input.audioBase64, 'base64');
  const { error } = await supabase.storage
    .from('generated-creatives')
    .upload(path, buffer, { contentType: input.mimeType, upsert: true });
  if (error) {
    throw new Error(`Audio upload failed for ${path}: ${error.message}`);
  }
  const { data } = supabase.storage.from('generated-creatives').getPublicUrl(path);
  return { path, publicUrl: data.publicUrl };
}
