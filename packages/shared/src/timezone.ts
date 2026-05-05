/**
 * IANA timezone helpers.
 *
 * Validation: prefer `Intl.supportedValuesOf('timeZone')` (Node 20+, modern
 * browsers). Fallback: a static set of common operator-relevant zones.
 *
 * Picker: a curated, region-grouped list intended for the settings form.
 * Operators in MMO/biz-opp/finance tend to be US/EU/SG/AU; the curated
 * list covers those plus a handful of "I just moved to Bali for the
 * tax break" common cases. Users can paste any valid IANA zone via API
 * — the validator accepts the full IANA database, not just the picker.
 */

const FALLBACK_ZONES: ReadonlySet<string> = new Set([
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Vancouver',
  'America/Mexico_City',
  'America/Bogota',
  'America/Sao_Paulo',
  'America/Buenos_Aires',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Amsterdam',
  'Europe/Brussels',
  'Europe/Berlin',
  'Europe/Zurich',
  'Europe/Rome',
  'Europe/Vienna',
  'Europe/Prague',
  'Europe/Warsaw',
  'Europe/Stockholm',
  'Europe/Oslo',
  'Europe/Helsinki',
  'Europe/Athens',
  'Europe/Bucharest',
  'Europe/Istanbul',
  'Europe/Moscow',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'Africa/Nairobi',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Manila',
  'Asia/Jakarta',
  'Australia/Perth',
  'Australia/Adelaide',
  'Australia/Sydney',
  'Australia/Brisbane',
  'Pacific/Auckland',
]);

/**
 * Strict validation. Accept any string that the runtime's Intl machinery
 * can use as a timezone (covers canonical IANA zones AND common aliases
 * like 'UTC' that supportedValuesOf canonicalizes to 'Etc/UTC').
 *
 * Why not Intl.supportedValuesOf alone: Node 20's ICU returns canonical
 * names only, so 'UTC' fails membership even though it's a perfectly
 * valid timezone for DateTimeFormat. Constructing a DateTimeFormat is the
 * canonical "can this string be used as a timeZone" test.
 *
 * Falls back to a static set when neither approach is available (very old
 * runtimes / pathological build environments).
 */
export function isValidIanaZone(tz: string): boolean {
  if (!tz || tz.trim() !== tz) return false;

  // Pre-check the IANA shape: 'UTC' exactly, or 'Region/City' (sometimes
  // 'Region/Subregion/City'). Rejects POSIX/legacy abbreviations like
  // 'PST', 'EST', 'utc' (case-insensitive variants) that DateTimeFormat
  // would otherwise accept.
  const isIanaShape = tz === 'UTC' || /^[A-Z][A-Za-z_]+(\/[A-Z][A-Za-z_-]+){1,2}$/.test(tz);
  if (!isIanaShape) return false;

  try {
    // Throws RangeError on unknown zones. Construct, ignore the result.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return FALLBACK_ZONES.has(tz);
  }
}

/**
 * Curated picker zones for the settings form, grouped by region. Caller
 * renders these as <optgroup>s. Order within a group is by UTC offset
 * (most western first) for scannability.
 */
export interface ZoneGroup {
  region: string;
  zones: string[];
}

export const TIMEZONE_PICKER_GROUPS: ZoneGroup[] = [
  {
    region: 'UTC',
    zones: ['UTC'],
  },
  {
    region: 'Americas',
    zones: [
      'Pacific/Honolulu',
      'America/Anchorage',
      'America/Los_Angeles',
      'America/Vancouver',
      'America/Phoenix',
      'America/Denver',
      'America/Chicago',
      'America/Mexico_City',
      'America/New_York',
      'America/Toronto',
      'America/Bogota',
      'America/Buenos_Aires',
      'America/Sao_Paulo',
    ],
  },
  {
    region: 'Europe / Africa',
    zones: [
      'Europe/Lisbon',
      'Europe/Dublin',
      'Europe/London',
      'Africa/Lagos',
      'Europe/Madrid',
      'Europe/Paris',
      'Europe/Amsterdam',
      'Europe/Brussels',
      'Europe/Berlin',
      'Europe/Zurich',
      'Europe/Rome',
      'Europe/Vienna',
      'Europe/Prague',
      'Europe/Warsaw',
      'Europe/Stockholm',
      'Europe/Oslo',
      'Europe/Helsinki',
      'Europe/Athens',
      'Europe/Bucharest',
      'Africa/Cairo',
      'Africa/Johannesburg',
      'Africa/Nairobi',
      'Europe/Istanbul',
      'Europe/Moscow',
    ],
  },
  {
    region: 'Asia / Pacific',
    zones: [
      'Asia/Dubai',
      'Asia/Kolkata',
      'Asia/Bangkok',
      'Asia/Jakarta',
      'Asia/Singapore',
      'Asia/Hong_Kong',
      'Asia/Shanghai',
      'Asia/Manila',
      'Australia/Perth',
      'Asia/Tokyo',
      'Asia/Seoul',
      'Australia/Adelaide',
      'Australia/Sydney',
      'Australia/Brisbane',
      'Pacific/Auckland',
    ],
  },
];

/** Default fallback when users.timezone is somehow unset. */
export const DEFAULT_TIMEZONE = 'America/New_York';
