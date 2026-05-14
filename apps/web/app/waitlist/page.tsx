import { redirect } from 'next/navigation';

/**
 * Phase 8: /waitlist now redirects to /apply. The form moved + got
 * richer fields (agency, monthly spend, verticals). Old inbound links
 * from Phase 7 still resolve via this redirect.
 *
 * The Phase-7 waitlist_entries table stays for historical records;
 * /admin/waitlist still reads it.
 */
export default function WaitlistRedirectPage() {
  redirect('/apply');
}
