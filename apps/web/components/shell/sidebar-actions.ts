'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Server action invoked by the sidebar's "Sign out" menu item. Keeping
 * it server-side (vs. relying on the client to wipe cookies directly)
 * means we go through Supabase's official sign-out path and the SSR
 * helper clears every auth cookie at once.
 */
export async function signOutAction(): Promise<void> {
  const supabase = await getSupabaseServerClient();
  await supabase.auth.signOut();
  revalidatePath('/', 'layout');
}
