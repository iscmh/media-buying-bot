'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { unpauseUser } from '@mbb/db';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export interface UnpauseResult {
  ok: boolean;
  message: string;
  closedReasons?: string[];
}

/**
 * Resume bot operations for the authed user. Closes ALL open
 * user_pause_log rows (not just the most recent — duplicate-reason leaks
 * are real if the user paused twice while still paused), flips
 * users.is_paused = false, audit-logs the unpause with the array of
 * reasons closed.
 *
 * Defensive: if the user isn't actually paused, returns ok=true with a
 * "nothing to do" message and writes no audit log. The banner shouldn't
 * be visible in that state anyway, but stale POSTs from a tab the user
 * left open shouldn't pollute the log.
 */
export async function unpauseUserAction(): Promise<UnpauseResult> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const result = await unpauseUser(user.id);
  revalidatePath('/dashboard');

  if (!result) {
    return { ok: true, message: 'Bot was not paused.' };
  }

  return {
    ok: true,
    message: `Bot resumed. Closed ${result.previousPauseCount} pause${
      result.previousPauseCount === 1 ? '' : 's'
    }.`,
    closedReasons: result.previousReasons,
  };
}
