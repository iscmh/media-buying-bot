import { describePipeline, pipelineFromString } from '@mbb/shared';

/**
 * Polish-25.6 Commit 34: shared helper to convert a raw
 * `providerChoice` / `format` string into a media-buyer-friendly
 * label. Kills the jargon leak the launch audit flagged (raw
 * `makeugc`, `polish25_makeugc`, `openai`, `static_openai_image`
 * surfacing on /runs, /pending, /concepts/[id]).
 *
 * Preference order:
 *   1. If the string maps to a canonical `PipelineType`, use the
 *      descriptor's label ("Instant UGC", "Static ad", etc.).
 *   2. Handful of hard-coded aliases for legacy providerChoice
 *      values that were never registered as PipelineType keys.
 *   3. Fall back to a title-cased version of the raw string —
 *      readable even for unknown enum values so we never render
 *      raw `snake_case` in the UI.
 */
export function friendlyPipeline(raw: string | null | undefined): string {
  if (!raw) return '—';
  const pipeline = pipelineFromString(raw);
  if (pipeline) return describePipeline(pipeline).label;
  if (raw === 'makeugc' || raw === 'polish25_makeugc') return 'Instant UGC';
  if (raw === 'openai') return 'Static ad';
  return raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
