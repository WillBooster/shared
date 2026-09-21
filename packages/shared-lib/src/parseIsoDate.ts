export type ParsedIsoDate = { kind: 'date'; value: string } | { kind: 'datetime'; value: string };

/**
 * Parses an ISO calendar date or a timestamp with an explicit UTC offset, without guessing
 * a timezone or rolling invalid calendar dates forward. Returns undefined for unsupported input.
 *
 * Accepts YYYY-MM-DD and YYYY-MM-DDTHH:mm[:ss[.fraction]] followed by Z or ±HH:mm
 * (±HHmm also works). Surrounding whitespace is ignored. Date-only values stay date-only;
 * timestamps become UTC strings, retaining all fractional digits. Local timestamps, unknown
 * offsets (-00:00/-0000), leap seconds, and input or normalized UTC years outside 0000–9999
 * are unsupported.
 */
export function parseIsoDate(input: unknown): ParsedIsoDate | undefined {
  if (typeof input !== 'string') return undefined;
  const value = input.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/u.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) {
    return undefined;
  }
  if (hourText === undefined) return { kind: 'date', value };
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? 0);
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const offset = parseOffset(zone!);
  if (offset === undefined) return undefined;
  local.setUTCHours(hour, minute - offset, second);
  if (local.getUTCFullYear() < 0 || local.getUTCFullYear() > 9999) return undefined;
  return { kind: 'datetime', value: `${local.toISOString().slice(0, 19)}${fraction ?? ''}Z` };
}

function parseOffset(zone: string): number | undefined {
  if (zone === 'Z') return 0;
  const digits = zone.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2));
  if (hours > 23 || minutes > 59 || (zone.startsWith('-') && hours === 0 && minutes === 0)) return undefined;
  return (zone.startsWith('-') ? -1 : 1) * (hours * 60 + minutes);
}
