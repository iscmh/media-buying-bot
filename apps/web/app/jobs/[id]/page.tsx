import { permanentRedirect } from 'next/navigation';

/**
 * Polish-18 Commit 1: the /jobs route renamed to /runs. This stub
 * issues a 308 Permanent Redirect so any existing share links,
 * pinned Telegram messages, or external bookmarks land cleanly on
 * the new URL.
 *
 * `permanentRedirect` returns HTTP 308 (not 301). 308 preserves the
 * request method, which doesn't matter for GET but is the
 * Next.js-blessed primitive for "moved permanently" semantics.
 */
interface Props {
  params: Promise<{ id: string }>;
}

export default async function JobsLegacyRedirect({ params }: Props) {
  const { id } = await params;
  permanentRedirect(`/runs/${id}`);
}
