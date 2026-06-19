/**
 * Polish-14.1: detect a source video's duration in seconds, client-side.
 *
 * Used by the generate form so the cost preview + the worker's
 * target_duration_seconds match the actual length of the uploaded
 * creative. Pure browser API — runs against either a File (upload
 * time) or a URL string (generate page reading a signed URL of the
 * already-uploaded source).
 *
 * Returns null when:
 *   - the input is not a video MIME (image source, text concept, etc.)
 *   - duration metadata never loads (network error, codec issue, etc.)
 *   - duration is Infinity (some live streams / broken WebM)
 *
 * Caller's responsibility to handle null (fall back to the 30s default).
 */

const URL_LOAD_TIMEOUT_MS = 8_000;

export async function detectVideoDurationFromFile(file: File): Promise<number | null> {
  if (!file.type.startsWith('video/')) return null;
  const url = URL.createObjectURL(file);
  try {
    return await readDurationFromUrl(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function detectVideoDurationFromUrl(url: string): Promise<number | null> {
  if (!url) return Promise.resolve(null);
  return readDurationFromUrl(url);
}

function readDurationFromUrl(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), URL_LOAD_TIMEOUT_MS);
    video.onloadedmetadata = () => {
      const d = video.duration;
      finish(Number.isFinite(d) && d > 0 ? d : null);
    };
    video.onerror = () => finish(null);
    video.src = url;
  });
}
