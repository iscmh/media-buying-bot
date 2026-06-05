/**
 * Polish-9: pure helpers for the reference-creative upload flow.
 * Extracted from actions.ts so vitest can cover them without needing
 * a full Supabase + Next.js server-action mock.
 */

export const MAX_REFERENCE_BYTES = 100 * 1024 * 1024; // 100 MB

const ALLOWED_REFERENCE_MIME = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/webm',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export function isAllowedReferenceMime(t: string): boolean {
  return ALLOWED_REFERENCE_MIME.has(t);
}

export function sanitizeFilename(name: string): string {
  // Strip path traversal + odd chars; keep dots so the extension survives.
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'upload';
}

/**
 * Storage paths must start with `<userId>/` to satisfy the RLS policy
 * on the reference-creatives bucket (migration 0028). Server actions
 * call this before downloading to defend against spoofed paths from
 * a stale or malicious client.
 */
export function storagePathBelongsToUser(storagePath: string, userId: string): boolean {
  if (!storagePath || typeof storagePath !== 'string') return false;
  if (storagePath.includes('..')) return false;
  return storagePath.startsWith(`${userId}/`);
}
