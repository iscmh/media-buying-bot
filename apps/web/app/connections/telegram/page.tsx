import { redirect } from 'next/navigation';

// Polish-25.1 Commit 10a: consolidated into /settings/connections.
export default function LegacyTelegramRedirect(): never {
  redirect('/settings/connections?tab=telegram');
}
