/*! Selected cases adapted from jsonrepair, Copyright (c) 2020-2026 Jos de Jong (ISC). See NOTICE. */
import { expect, test } from 'vitest';
import { recoverJson } from '../../src/index.js';

test('recovers complete LLM answers without changing their data', () => {
  const cases = [
    [
      '{"a":2.3e100,"b":"str","c":null,"d":false,"e":[1,2,3]}',
      // oxlint-disable-next-line unicorn/no-null -- JSON null must survive recovery unchanged.
      { a: 2.3e100, b: 'str', c: null, d: false, e: [1, 2, 3] },
    ],
    ["{name: 'John',}", { name: 'John' }],
    ['{“name”: “John”}', { name: 'John' }],
    ['{"a": 1 /* comment */ , "b": True}', { a: 1, b: true }],
    ['{"a": "hi\nthere"}', { a: 'hi\nthere' }],
    [
      String.raw`{"a": "\u2605", "b": "😀", "c": "https://example.com/*text*/"}`,
      { a: '★', b: '😀', c: 'https://example.com/*text*/' },
    ],
    ['{"a": 1 "b": 2}', { a: 1, b: 2 }],
  ] as const;
  for (const [input, value] of cases) {
    const result = recoverJson(input);
    expect(result.errors).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate.value).toEqual(value);
    expect(JSON.parse(candidate.json)).toEqual(value);
    expect(candidate.requiresConfirmation).toBe(false);
    expect(recoverJson(candidate.json).candidates[0]?.repairs).toEqual([]);
  }
});

test('returns all fenced answers and original response offsets', () => {
  const text = 'Example:\n```json\n{"verdict":"confirmed"}\n```\nAnswer:\n~~~~json\n{verdict: "refuted",}\n~~~~';
  const { candidates, errors } = recoverJson(text);
  expect(errors).toEqual([]);
  expect(candidates.map((candidate) => candidate.value)).toEqual([{ verdict: 'confirmed' }, { verdict: 'refuted' }]);
  expect(candidates[0]?.repairs).toEqual([]);
  const repaired = candidates[1]!;
  expect(text.slice(repaired.start, repaired.end)).toBe('{verdict: "refuted",}');
  expect(repaired.repairs.some((repair) => text.slice(repair.offset).startsWith('verdict'))).toBe(true);
});

test('rescues partial explanations without presenting them as complete answers', () => {
  for (const suffix of ['unfinished', 'unfinished\\', String.raw`unfinished\u12`]) {
    const text = `Here is the result:\n\`\`\`json\n{"verdict":"refuted","notes":"${suffix}`;
    const candidate = recoverJson(text).candidates[0]!;
    expect(candidate.value).toEqual({ verdict: 'refuted', notes: suffix });
    expect(candidate.requiresConfirmation).toBe(true);
    expect(candidate.repairs.some((repair) => repair.kind === 'incomplete')).toBe(true);
  }
  for (const text of ['{"verdict":"refuted"', '{"verdict":"refuted","notes":', '[1,2,']) {
    const candidate = recoverJson(text).candidates[0]!;
    expect(candidate.requiresConfirmation).toBe(true);
    expect(() => JSON.parse(candidate.json)).not.toThrow();
  }
});

test('exposes ambiguity and never translates domain values', () => {
  for (const text of ['{"verdict":"refuted","verdict":"confirmed"}', '{"a" "b"}', '{"a":word}', '[,1]']) {
    const candidate = recoverJson(text).candidates[0]!;
    expect(candidate.requiresConfirmation).toBe(true);
    expect(candidate.repairs.some((repair) => repair.kind === 'ambiguous')).toBe(true);
  }
  expect(recoverJson('{"evidence":{"kind":"repro"}}').candidates[0]?.value).toEqual({ evidence: { kind: 'repro' } });
  expect(recoverJson('{"__proto__":{"polluted":true}}').candidates[0]?.value).toEqual(
    JSON.parse('{"__proto__":{"polluted":true}}')
  );
  expect(Object.hasOwn({}, 'polluted')).toBe(false);
});

test('bounds malformed input and does not mine a rejected outer document for a verdict', () => {
  expect(recoverJson('{] "nested": {"verdict":"refuted"}}').candidates).toEqual([]);
  expect(recoverJson('x'.repeat(1_000_001)).errors).toHaveLength(1);
  expect(recoverJson('['.repeat(130)).errors).toHaveLength(1);
  expect(recoverJson('{}\n'.repeat(40)).candidates).toHaveLength(32);
});

test('valid JSON survives truncation at every position without inventing a complete answer', () => {
  const text = String.raw`{"verdict":"refuted","evidence":{"summary":"Quoted \"text\" and \u2605"}}`;
  const original = JSON.parse(text);
  expect(recoverJson(text).candidates[0]?.value).toEqual(original);
  for (let end = 1; end < text.length; end++) {
    const result = recoverJson(text.slice(0, end));
    for (const candidate of result.candidates) {
      expect(candidate.requiresConfirmation).toBe(true);
      expect(() => JSON.parse(candidate.json)).not.toThrow();
    }
  }
});
