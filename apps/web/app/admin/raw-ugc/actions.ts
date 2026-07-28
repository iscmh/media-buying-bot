'use server';

import { checkMakeugcVideoStatus, listMakeugcVoices, submitMakeugcVideo } from '@mbb/ai-providers';
import { requireAdmin } from '@/lib/admin-gate';

/**
 * Polish-25.6 Commit 35: admin-only raw MakeUGC generator server
 * actions. No DB persistence — this is a personal tool for the
 * operator to spin one-off UGC videos for their own ad campaigns.
 * Video URLs come back from MakeUGC's CDN, admin downloads directly.
 *
 * NO SHARED CODE WITH POLISH-25 USER WORKER. Reuses the raw MakeUGC
 * client functions (`submitMakeugcVideo`, `checkMakeugcVideoStatus`,
 * `listMakeugcVoices`) — the same primitives Polish-25 wraps, but
 * without the analysis / condenser / avatar-matcher pipeline the
 * user-facing flow adds. Skipping those steps is the whole point.
 *
 * Auth: every action guards `requireAdmin()` first. Never invocable
 * by a non-admin session cookie.
 *
 * Key resolution: reads MAKEUGC_MANAGED_KEY directly (the operator's
 * platform key). Falls back to a clear error if missing so the admin
 * knows what to set. NOT using `resolveMakeugcKey` from packages/jobs
 * because that helper also probes for user BYOK — for an admin tool
 * the platform key is the only correct source.
 */

const ENV_KEY_NAME = 'MAKEUGC_MANAGED_KEY';

function resolveManagedKey(): string {
  const key = process.env[ENV_KEY_NAME]?.trim();
  if (!key || key.length === 0) {
    throw new Error(`${ENV_KEY_NAME} env var is not set. Set it in Vercel + local .env.`);
  }
  return key;
}

export interface SubmitRawUgcInput {
  avatarId: string;
  voiceId?: string;
  script: string;
  videoName?: string;
}

export interface SubmitRawUgcResult {
  ok: boolean;
  videoId?: string;
  errorMessage?: string;
}

/**
 * Fire the MakeUGC submit call with the admin's picked avatar +
 * script. Returns quickly with the video id; client polls
 * `checkRawUgcStatusAction` every few seconds until it flips to
 * completed or failed.
 */
export async function submitRawUgcAction(input: SubmitRawUgcInput): Promise<SubmitRawUgcResult> {
  const { userId } = await requireAdmin();

  if (!input.avatarId) return { ok: false, errorMessage: 'Pick an avatar first.' };
  if (!input.script?.trim()) return { ok: false, errorMessage: 'Script is empty.' };

  let apiKey: string;
  try {
    apiKey = resolveManagedKey();
  } catch (err) {
    return { ok: false, errorMessage: err instanceof Error ? err.message : String(err) };
  }

  try {
    const result = await submitMakeugcVideo({
      userId, // for provider-log correlation only
      apiKey,
      avatarId: input.avatarId,
      voiceScript: input.script,
      voiceId: input.voiceId || undefined,
      videoName: input.videoName || `admin-raw-${new Date().toISOString().slice(0, 19)}`,
    });
    if (!result.ok) {
      return {
        ok: false,
        errorMessage: result.errorMessage ?? 'MakeUGC submit returned not-ok without a message.',
      };
    }
    return { ok: true, videoId: result.videoId };
  } catch (err) {
    return { ok: false, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

export interface CheckRawUgcResult {
  ok: boolean;
  status: 'processing' | 'completed' | 'failed';
  url?: string;
  errorMessage?: string;
}

/**
 * Client polls this every ~5s while a submit is in flight. Returns
 * the same shape the underlying client returns — status +
 * (on completed) url pointing at MakeUGC's CDN.
 */
export async function checkRawUgcStatusAction(videoId: string): Promise<CheckRawUgcResult> {
  const { userId } = await requireAdmin();
  if (!videoId) return { ok: false, status: 'failed', errorMessage: 'Missing videoId.' };

  let apiKey: string;
  try {
    apiKey = resolveManagedKey();
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const result = await checkMakeugcVideoStatus({ userId, apiKey, videoId });
    if (!result.ok) {
      return {
        ok: false,
        status: 'failed',
        errorMessage: result.errorMessage ?? 'MakeUGC status returned not-ok without a message.',
      };
    }
    return { ok: true, status: result.status, url: result.url };
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface RawUgcVoice {
  id: string;
  name: string;
  language?: string;
  gender?: string;
  accent?: string;
}

export interface ListRawUgcVoicesResult {
  ok: boolean;
  voices: RawUgcVoice[];
  errorMessage?: string;
}

/**
 * Load the MakeUGC voice catalog on demand for the optional voice
 * override dropdown. Filtered by gender when passed. Kept as a
 * server action (not a static prop on the page) so the page-load
 * time isn't blocked on a 15s upstream — the client requests voices
 * only after the admin picks an avatar.
 */
export async function listRawUgcVoicesAction(gender?: string): Promise<ListRawUgcVoicesResult> {
  const { userId } = await requireAdmin();
  let apiKey: string;
  try {
    apiKey = resolveManagedKey();
  } catch (err) {
    return {
      ok: false,
      voices: [],
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  const normalizedGender: 'Male' | 'Female' | undefined =
    gender === 'Male' || gender === 'Female' ? gender : undefined;

  try {
    const result = await listMakeugcVoices({
      userId,
      apiKey,
      gender: normalizedGender,
      language: 'English',
    });
    if (!result.ok) {
      return {
        ok: false,
        voices: [],
        errorMessage: result.errorMessage ?? 'MakeUGC voices returned not-ok.',
      };
    }
    return {
      ok: true,
      voices: result.voices.map((v) => ({
        id: v.id,
        name: v.name,
        language: v.language,
        gender: v.gender,
        accent: v.accent,
      })),
    };
  } catch (err) {
    return {
      ok: false,
      voices: [],
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
