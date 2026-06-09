import { NextResponse } from 'next/server';

/**
 * Temporary diagnostic endpoint. Returns model-id env-var presence so
 * we can verify Vercel runtime sees the same values the dashboard
 * advertises. NO sensitive values exposed — model IDs are public on
 * Replicate; voice ID is a public ElevenLabs identifier; NODE_ENV is
 * not secret. Provider API keys + Supabase keys are NOT included.
 *
 * Will be deleted once Polish-11 / Polish-11.x rollout is verified.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    KLING_MODEL_ID: process.env.KLING_MODEL_ID ?? null,
    REPLICATE_VIDEO_CONCAT_MODEL_ID: process.env.REPLICATE_VIDEO_CONCAT_MODEL_ID ?? null,
    REPLICATE_LIPSYNC_MODEL_ID: process.env.REPLICATE_LIPSYNC_MODEL_ID ?? null,
    ELEVENLABS_DEFAULT_VOICE_ID: process.env.ELEVENLABS_DEFAULT_VOICE_ID ?? null,
    REPLICATE_KLING_OMNI_MODEL_ID: process.env.REPLICATE_KLING_OMNI_MODEL_ID ?? null,
    NODE_ENV: process.env.NODE_ENV ?? null,
    timestamp: new Date().toISOString(),
  });
}
