// Stable date formatting that produces identical output on server and client.
// Avoids hydration mismatches caused by locale-dependent toLocaleString().
//
// Format: "DD MMM YYYY, HH:MM" in UTC (e.g. "04 May 2026, 15:42")
// Trade-off: not localized, but consistent. Acceptable for operator-tool UI.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

export function formatDateTime(d: Date | null | undefined): string {
  if (!d) return 'unknown';
  return (
    pad(d.getUTCDate()) +
    ' ' +
    MONTHS[d.getUTCMonth()] +
    ' ' +
    d.getUTCFullYear() +
    ', ' +
    pad(d.getUTCHours()) +
    ':' +
    pad(d.getUTCMinutes()) +
    ' UTC'
  );
}

export function formatDate(d: Date | null | undefined): string {
  if (!d) return 'never';
  return pad(d.getUTCDate()) + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}
