const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Formats the calendar date of `date` in an IANA `timeZone` (e.g. `Asia/Tokyo`) as YYYY-MM-DD, independent of the
 * runtime's local time zone, which is UTC on Cloudflare Workers and most servers.
 * Supports ISO years 0000–9999, like `parseIsoDate`. Throws a `RangeError` for an unknown time zone.
 */
export function formatIsoDateInTimeZone(date: Date, timeZone: string): string {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // Constructing a formatter costs far more than formatting, so one is kept per time zone.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      era: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  let year = 0;
  let isBeforeCommonEra = false;
  let month = '';
  let day = '';
  // `formatToParts` is used instead of a locale whose format happens to be YYYY-MM-DD (e.g. `en-CA`), since such
  // formats follow CLDR updates.
  for (const part of formatter.formatToParts(date)) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'era') isBeforeCommonEra = part.value === 'BC';
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  // The Gregorian calendar has no year 0: ISO year 0000 is 1 BC.
  return `${String(isBeforeCommonEra ? 1 - year : year).padStart(4, '0')}-${month}-${day}`;
}
