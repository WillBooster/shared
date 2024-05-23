import { expect, test } from 'vitest';

import { humanizeNumber } from '../src/humanize.js';

test('humanizeNumber with values less than base', () => {
  expect(humanizeNumber(999)).toBe('999');
  expect(humanizeNumber(500)).toBe('500');
});

test('humanizeNumber with values equal to base', () => {
  expect(humanizeNumber(1000)).toBe('1.00K');
});

test('humanizeNumber with values greater than base', () => {
  expect(humanizeNumber(1500)).toBe('1.50K');
  expect(humanizeNumber(1_000_000)).toBe('1.00M');
  expect(humanizeNumber(2_500_000)).toBe('2.50M');
  expect(humanizeNumber(25_000_000)).toBe('25.00M');
  expect(humanizeNumber(250_000_000)).toBe('250.00M');
});

test('humanizeNumber with custom units and base', () => {
  expect(humanizeNumber(1024, { units: ['Ki', 'Mi', 'Gi'], base: 1024 })).toBe('1.00Ki');
  expect(humanizeNumber(1_048_576, { units: ['Ki', 'Mi', 'Gi'], base: 1024 })).toBe('1.00Mi');
});

test('humanizeNumber with large values', () => {
  expect(humanizeNumber(1e12)).toBe('1.00T');
  expect(humanizeNumber(1e15)).toBe('1.00P');
  expect(humanizeNumber(1e18)).toBe('1000.00P');
});
