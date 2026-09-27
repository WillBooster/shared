import { expect, test } from 'bun:test';

import { formatIsoDateInTimeZone } from '../../src/formatIsoDate.js';

test('formatIsoDateInTimeZone uses the calendar date in the given time zone', () => {
  const instant = new Date('2026-12-31T15:30:00Z');
  expect(formatIsoDateInTimeZone(instant, 'Asia/Tokyo')).toBe('2027-01-01');
  expect(formatIsoDateInTimeZone(instant, 'UTC')).toBe('2026-12-31');
  expect(formatIsoDateInTimeZone(new Date('0099-03-04T00:00:00Z'), 'UTC')).toBe('0099-03-04');
  expect(formatIsoDateInTimeZone(new Date('0000-01-01T00:00:00Z'), 'UTC')).toBe('0000-01-01');
  expect(formatIsoDateInTimeZone(new Date('0001-01-01T00:00:00Z'), 'Asia/Tokyo')).toBe('0001-01-01');
});
