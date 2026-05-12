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
 * Used by analyze-concept for video → Gemini Vision inline_data.
 *
 * Hard cap of 20 MB — Gemini Vision inline_data limit. Caller should
 * pre-validate at job-submit time so we get a clean error before we burn
 * an Inngest step on a too-large file.
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
}): Promise<{ path: string; publicUrl: string }> {
  const supabase = getServiceRoleSupabase();
  const ext = input.mimeType === 'image/jpeg' ? '.jpg' : '.png';
  const path = `${input.userId}/generated/${input.jobId}/${input.variantIndex}${ext}`;
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
