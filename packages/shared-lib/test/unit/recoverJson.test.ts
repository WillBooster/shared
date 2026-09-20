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
    ['{”name”: ”John”}', { name: 'John' }],
    ['{’name’: ’John’}', { name: 'John' }],
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

test('does not treat numbered prose or Markdown bullets as root scalar answers', () => {
  for (const prose of ['3 issues found. Details:', '- summary', 'true story follows:']) {
    const result = recoverJson(`${prose}\n\`\`\`json\n{"verdict":"confirmed"}\n\`\`\``);
    expect(result.candidates.map((candidate) => candidate.value)).toEqual([{ verdict: 'confirmed' }]);
  }
  expect(recoverJson(' 42 ').candidates[0]?.value).toBe(42);
  expect(recoverJson('```json\n"answer"\n```').candidates[0]?.value).toBe('answer');
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
  for (const text of ['{"verdict":"refuted","verdict":"confirmed"}', '{"a" "b"}', '{"a":word}', '{,a:1}']) {
    const candidate = recoverJson(text).candidates[0]!;
    expect(candidate.requiresConfirmation).toBe(true);
    expect(candidate.repairs.some((repair) => repair.kind === 'ambiguous')).toBe(true);
  }
  expect(recoverJson('{"evidence":{"kind":"repro"}}').candidates[0]?.value).toEqual({ evidence: { kind: 'repro' } });
  expect(recoverJson('{"__proto__":{"polluted":true}}').candidates[0]?.value).toEqual(
    JSON.parse('{"__proto__":{"polluted":true}}')
  );
  expect('polluted' in {}).toBe(false);
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
    expect(result.candidates).toHaveLength(1);
    for (const candidate of result.candidates) {
      expect(candidate.requiresConfirmation).toBe(true);
      expect(() => JSON.parse(candidate.json)).not.toThrow();
    }
  }
});

test('reports the original trailing comma and enforces container depth consistently', () => {
  for (const input of ['[1, ]', '{"a":1, \n }']) {
    const repair = recoverJson(input).candidates[0]?.repairs.find((item) => item.reason === 'trailing-comma');
    expect(repair?.offset).toBe(input.indexOf(','));
  }
  for (const middle of ['', '1']) {
    expect(recoverJson('['.repeat(128) + middle + ']'.repeat(128)).errors).toEqual([]);
    expect(recoverJson('['.repeat(129) + middle + ']'.repeat(129)).errors).toHaveLength(1);
  }
});

test('keeps fence opener content and fences embedded inside JSON strings', () => {
  const embedded = '{"explanation":"Use this:\n```js\nconst a = 1;\n```\nDone"}';
  for (const input of [embedded, `\`\`\`json\n${embedded}\n\`\`\``]) {
    const candidate = recoverJson(input).candidates[0]!;
    expect(candidate.value).toEqual({ explanation: 'Use this:\n```js\nconst a = 1;\n```\nDone' });
    expect(candidate.requiresConfirmation).toBe(true);
  }
  expect(recoverJson('```json {"verdict":"confirmed"}\n```').candidates[0]?.value).toEqual({ verdict: 'confirmed' });
});

test('removes adjacent comments without incorporating them into keys or values', () => {
  for (const input of ['{a/*comment*/:1}', '{"a":1/*comment*/}', '{a//comment\n:1}', '{"a":1//comment\n}']) {
    const candidate = recoverJson(input).candidates[0]!;
    expect(candidate.value).toEqual({ a: 1 });
    expect(candidate.requiresConfirmation).toBe(false);
  }
});

test('recovers mismatched quotes as ambiguous while preserving valid quoted content', () => {
  const candidate = recoverJson('{"verdict": "refuted”, "notes": "fine"}').candidates[0]!;
  expect(candidate.value).toEqual({ verdict: 'refuted', notes: 'fine' });
  expect(candidate.requiresConfirmation).toBe(true);
  expect(candidate.repairs.some((repair) => repair.reason === 'mismatched-quote')).toBe(true);
  const valid = '{"notes":"He said “hi”, then left"}';
  expect(recoverJson(valid).candidates[0]?.value).toEqual(JSON.parse(valid));
  expect(recoverJson(valid).candidates[0]?.repairs).toEqual([]);
  for (const value of ['a”', 'The user said “thanks”', 'a “b”, then c']) {
    const fenced = recoverJson(`\`\`\`json\n${JSON.stringify(value)}\n\n\`\`\``).candidates[0]!;
    expect(fenced.value).toBe(value);
    expect(fenced.repairs).toEqual([]);
  }
});

test('retains scalar comments and separates standalone answers from later prose', () => {
  for (const value of ['42', 'true', 'false', 'null']) {
    for (const suffix of [' // answer', '/*answer*/', '\n// answer', '//answer']) {
      const candidate = recoverJson(value + suffix).candidates[0]!;
      expect(candidate.value).toEqual(JSON.parse(value));
      expect(candidate.requiresConfirmation).toBe(false);
      expect(candidate.repairs.some((repair) => repair.reason.endsWith('comment'))).toBe(true);
    }
  }
  const candidate = recoverJson('"confirmed"\nExplanation of the result.').candidates[0]!;
  expect(candidate.value).toBe('confirmed');
  expect(candidate.requiresConfirmation).toBe(true);
});

test('preserves missing array positions and literal invalid escapes for confirmation', () => {
  const candidate = recoverJson('[1,,3]').candidates[0]!;
  expect(candidate.value).toEqual(JSON.parse('[1,null,3]'));
  expect(candidate.requiresConfirmation).toBe(true);
  const escaped = recoverJson(String.raw`{"summary":"user\'s request"}`).candidates[0]!;
  expect(escaped.value).toEqual({ summary: String.raw`user\'s request` });
  expect(escaped.requiresConfirmation).toBe(true);
  const key = recoverJson('{notes": "cut off"}').candidates[0]!;
  expect(key.value).toEqual({ 'notes"': 'cut off' });
  expect(key.requiresConfirmation).toBe(true);
});

test('continues after rejected documents without extracting their nested members', () => {
  for (const prefix of [
    'See [PR-12: fix] for details:',
    'Candidate 1: {"error": [}\nCandidate 2:',
    '{] "nested": {"verdict":"wrong"}}',
  ]) {
    const result = recoverJson(`${prefix} {"verdict":"confirmed"}`);
    expect(result.candidates.map((candidate) => candidate.value)).toEqual([{ verdict: 'confirmed' }]);
    expect(result.errors).toHaveLength(1);
  }
});

test('keeps a truncated fenced answer separate from a following complete answer', () => {
  const input =
    '```json\n{"notes":"unfinished\n```\nSorry, cut off. Full answer:\n```json\n{"verdict":"confirmed"}\n```';
  const { candidates } = recoverJson(input);
  expect(candidates.map((candidate) => candidate.value)).toEqual([{ notes: 'unfinished\n' }, { verdict: 'confirmed' }]);
  expect(candidates[0]?.requiresConfirmation).toBe(true);
  expect(candidates[1]?.repairs).toEqual([]);
  const partial = recoverJson('```json\n{"notes":"cut off\n```\nI ran out of space.').candidates[0]!;
  expect(partial.value).toEqual({ notes: 'cut off\n' });
  expect(partial.requiresConfirmation).toBe(true);
});

test('keeps repair provenance within the retained string interpretation', () => {
  for (const input of ['["a”, ]and more\n', '["hi”, ]oops\ntail', 'b["ea  -“n“]rax\nu']) {
    const candidate = recoverJson(input).candidates[0]!;
    expect(candidate.requiresConfirmation).toBe(true);
    expect(candidate.repairs.some((repair) => repair.reason === 'unescaped-control-character')).toBe(false);
    for (const repair of candidate.repairs) {
      expect(repair.offset).toBeGreaterThanOrEqual(candidate.start);
      expect(repair.offset).toBeLessThanOrEqual(candidate.end);
    }
  }
});

test('distinguishes a closed malformed Unicode escape from an exhausted escape', () => {
  for (const hex of ['', '1', '12', '123']) {
    for (const closed of [true, false]) {
      const candidate = recoverJson(`"\\u${hex}${closed ? '"' : ''}`).candidates[0]!;
      expect(candidate.value).toBe(`\\u${hex}`);
      expect(candidate.requiresConfirmation).toBe(true);
      expect(candidate.repairs.some((repair) => repair.kind === 'incomplete')).toBe(!closed);
    }
  }
});
