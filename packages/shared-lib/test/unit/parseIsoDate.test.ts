import { execFileSync } from 'node:child_process';

import { expect, test } from 'vitest';

import { parseIsoDate } from '../../src/index.js';

test.each(['UTC', 'Asia/Tokyo', 'America/New_York'])('parses independently of the process timezone (%s)', (tz) => {
  const output = execFileSync(
    'bun',
    [
      '-e',
      `
      import { parseIsoDate } from ${JSON.stringify(new URL('../../src/index.ts', import.meta.url).href)};
      console.log(JSON.stringify([
        parseIsoDate('2026-01-01T08:30:00.123456789+09:00'),
        parseIsoDate('2024-02-29'),
      ]));
    `,
    ],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8' }
  );
  expect(JSON.parse(output)).toEqual([
    { kind: 'datetime', value: '2025-12-31T23:30:00.123456789Z' },
    { kind: 'date', value: '2024-02-29' },
  ]);
});

test('normalizes equivalent instants across date and year boundaries', () => {
  const expected = { kind: 'datetime', value: '2025-12-31T23:30:00Z' };
  for (const value of ['2026-01-01T08:30+09:00', '2025-12-31T18:30:00-0500', '2025-12-31T23:30:00Z']) {
    expect(parseIsoDate(value)).toEqual(expected);
  }
});

test('retains calendar dates without inventing an instant', () => {
  expect(parseIsoDate(' 2024-02-29 ')).toEqual({ kind: 'date', value: '2024-02-29' });
  expect(parseIsoDate('0099-01-01')).toEqual({ kind: 'date', value: '0099-01-01' });
  expect(parseIsoDate('0000-02-29')).toEqual({ kind: 'date', value: '0000-02-29' });
});

test('retains fractional precision and is stable when parsing its own output', () => {
  for (const value of ['2026-01-01T00:00:00.123456789+09:00', '0099-12-31T23:59:59.1Z', '2024-02-29']) {
    const parsed = parseIsoDate(value);
    expect(parsed).toBeDefined();
    expect(parseIsoDate(parsed!.value)).toEqual(parsed);
  }
  expect(parseIsoDate('2026-01-01T00:00:00.123456789+09:00')).toEqual({
    kind: 'datetime',
    value: '2025-12-31T15:00:00.123456789Z',
  });
});

test('rejects calendar overflow rather than silently moving to a different day', () => {
  for (const date of [
    '2026-02-29',
    '1900-02-29',
    '2024-02-30',
    '2026-04-31',
    '2026-00-10',
    '2026-13-01',
    '2026-01-00',
  ]) {
    expect(parseIsoDate(date)).toBeUndefined();
    expect(parseIsoDate(`${date}T12:00:00+09:00`)).toBeUndefined();
  }
  expect(parseIsoDate('2000-02-29T12:00:00Z')).toEqual({ kind: 'datetime', value: '2000-02-29T12:00:00Z' });
});

test('rejects missing or unknown timezones and out-of-range time components', () => {
  for (const value of [
    '2026-09-21T09:00',
    '2026-09-21T09:00:00-00:00',
    '2026-09-21T09:00:00-0000',
    '2026-09-21T24:00:00Z',
    '2026-09-21T09:60:00Z',
    '2026-09-21T09:00:60Z',
    '2026-09-21T09:00:00+24:00',
    '2026-09-21T09:00:00+09:60',
    '0000-01-01T00:00:00+01:00',
    '9999-12-31T23:59:59-01:00',
  ])
    expect(parseIsoDate(value)).toBeUndefined();
});

test('rejects unstructured values instead of applying runtime date coercion', () => {
  // oxlint-disable-next-line unicorn/no-null -- External JSON can contain null dates.
  for (const value of [undefined, null, 0, new Date(), {}, '', 'tomorrow', '09/10/2026', '2026-09-21 extra']) {
    expect(parseIsoDate(value)).toBeUndefined();
  }
});
