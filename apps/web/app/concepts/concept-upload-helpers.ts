/**
 * Polish-9.1: pure helpers for the concept signed-URL upload flow.
 * Mirror of the Polish-9 reference-creative helpers but with the
 * concept-specific mime allowlist (images + videos) and the
 * <userId>/concepts/<conceptId>/source.<ext> path scheme that matches
 * the existing 'concepts' bucket RLS from migration 0006.
 *
 * Extracted so vitest can cover the validation surface without needing
 * a full Supabase + Next.js server-action mock.
 */

export const CONCEPT_STATIC_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const CONCEPT_UGC_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

const STATIC_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const UGC_MIME = new Set(['video/mp4', 'video/quicktime', 'video/x-m4v', 'video/webm']);

export type ConceptUploadContentType = 'static' | 'ugc';

export function isAllowedConceptMime(t: string, contentType: ConceptUploadContentType): boolean {
  return contentType === 'static' ? STATIC_MIME.has(t) : UGC_MIME.has(t);
}

export function maxConceptBytes(contentType: ConceptUploadContentType): number {
  return contentType === 'static' ? CONCEPT_STATIC_MAX_BYTES : CONCEPT_UGC_MAX_BYTES;
}

export function sanitizeConceptExt(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx < 0) return '';
  const ext = filename.slice(idx).toLowerCase();
  const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.mov', '.m4v', '.webm']);
  return allowed.has(ext) ? ext : '';
}

/**
 * Storage paths under the 'concepts' bucket must start with the user's
 * id (the bucket RLS in migration 0006 enforces this on the storage
 * side too — this helper is the defense-in-depth gate in the server
 * action). Mirrors the Polish-9 storagePathBelongsToUser shape.
 */
export function conceptStoragePathBelongsToUser(storagePath: string, userId: string): boolean {
  if (!storagePath || typeof storagePath !== 'string') return false;
  if (storagePath.includes('..')) return false;
  return storagePath.startsWith(`${userId}/concepts/`);
}

export function stripConceptExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  const base = idx > 0 ? filename.slice(0, idx) : filename;
  return base.split(/[\\/]/).pop()!.trim().slice(0, 120) || 'Untitled concept';
}
