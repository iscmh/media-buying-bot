import { redirect } from 'next/navigation';

/**
 * Polish-29.0.8 Commit 117: legacy redirect.
 *
 * The `keys` onboarding step was removed — the default video path
 * (credit-backed Seedance) needs zero BYOK keys. This page used to
 * gate onboarding on Claude + Gemini connections; it now redirects
 * users who land here (old bookmarks, stale emails) to the connections
 * settings page where BYOK is an OPT-IN power-user surface.
 *
 * See packages/shared/src/onboarding.ts + packages/db/src/onboarding.ts
 * for the trimmed 2-step chain (tos → risk).
 */
export const dynamic = 'force-dynamic';

export default function OnboardingKeysRedirect() {
  redirect('/settings/connections');
}
