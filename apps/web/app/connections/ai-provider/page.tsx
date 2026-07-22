import { redirect } from 'next/navigation';

// Polish-25.1 Commit 10a: consolidated into /settings/connections.
// Redirect stub preserved so legacy bookmarks + external links still
// land in the right place.
export default function LegacyAiProviderRedirect(): never {
  redirect('/settings/connections?tab=providers');
}
