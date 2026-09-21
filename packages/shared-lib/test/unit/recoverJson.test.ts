/*! Selected cases adapted from jsonrepair, Copyright (c) 2020-2026 Jos de Jong (ISC). See NOTICE. */
import { expect, test } from 'vitest';
import { recoverJson } from '../../src/index.js';

test('recovers complete LLM answers without changing their data', () => {
  const astralCharacter = '😀';
  const cases = [
    [
      '{"a":2.3e100,"b":"str","c":null,"d":false,"e":[1,2,3]}',
      // oxlint-disable-next-line unicorn/no-null -- JSON null must survive recovery unchanged.
      { a: 2.3e100, b: 'str', c: null, d: false, e: [1, 2, 3] },
    ],
    ["{name: 'John',}", { name: 'John' }],
    [String.raw`{'summary': 'it\'s complete'}`, { summary: "it's complete" }],
    [String.raw`['don\'t stop']`, ["don't stop"]],
    ['{“name”: “John”}', { name: 'John' }],
    ['{”name”: ”John”}', { name: 'John' }],
    ['{’name’: ’John’}', { name: 'John' }],
    ['{"a": 1 /* comment */ , "b": True}', { a: 1, b: true }],
    ['{"a": "hi\nthere"}', { a: 'hi\nthere' }],
    [
      String.raw`{"a": "\u2605", "b": "${astralCharacter}", "c": "https://example.com/*text*/"}`,
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
  expect(text.slice(repaired.start, repaired.end)).toBe('{verdict: "refuted",}\n');
  expect(repaired.repairs.some((repair) => text.slice(repair.offset).startsWith('verdict'))).toBe(true);
});

test('preserves standard JSON escapes in structured explanations without repairs', () => {
  const input = String.raw`{"url":"https:\/\/example.com","pattern":"\\d+","notes":"\"quoted\"\nline\r\n\ttab\bbackspace\fformfeed"}`;
  const result = recoverJson(input);
  expect(result.errors).toEqual([]);
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]?.value).toEqual(JSON.parse(input));
  expect(result.candidates[0]?.repairs).toEqual([]);
  expect(result.candidates[0]?.requiresConfirmation).toBe(false);
});

test('recovers quoted ratios without absorbing separate numbers or comment trivia', () => {
  for (const fragment of ['hi, there', 'hi*there', 'hi{there', 'hi\rthere', 'hi\nthere']) {
    const result = recoverJson(`{"v":"He said "${fragment}" ok"}\n\`\`\`json\n{"verdict":"refuted"}\n\`\`\``);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.value).toMatchObject({ v: 'He said ' });
    expect(result.candidates[0]?.requiresConfirmation).toBe(true);
    expect(result.candidates[1]?.value).toEqual({ verdict: 'refuted' });
    expect(result.candidates[1]?.requiresConfirmation).toBe(false);
  }
  for (const fragment of ['hi[there', 'hi]there']) {
    const result = recoverJson(`{"v":"He said "${fragment}" ok"}\n\`\`\`json\n{"verdict":"refuted"}\n\`\`\``);
    expect(result.candidates.map((candidate) => candidate.value)).toEqual([{ verdict: 'refuted' }]);
    expect(result.errors.some((error) => error.message === 'Mismatched closing bracket')).toBe(true);
  }
  for (const phrase of ['985/211', '2.3', '2fa', '3.0.1']) {
    const summary = `includes "${phrase}" items`;
    const result = recoverJson(`{"summary":"${summary}","verdict":"refuted"}`);
    expect(result.errors).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.value).toEqual({ summary, verdict: 'refuted' });
    expect(result.candidates[0]?.requiresConfirmation).toBe(true);
  }
  for (const number of ['2', '2.5', '2e10']) {
    const candidate = recoverJson(`["a" ${number}]`).candidates[0]!;
    expect(candidate.value).toEqual(['a', Number(number)]);
    expect(candidate.requiresConfirmation).toBe(false);
  }
  for (const comment of ['/* note */', '// note\n']) {
    const candidate = recoverJson(`["a"${comment},"b"]`).candidates[0]!;
    expect(candidate.value).toEqual(['a', 'b']);
    expect(candidate.repairs.some((repair) => repair.reason === 'unescaped-quote')).toBe(false);
  }
});

test('exposes surplus root closers and their continuation without guessing parentage', () => {
  for (const input of ['{"a":{"b":1}}},"c":2}', '```json\n{"a":{"b":1}}},"c":2}\n```']) {
    const result = recoverJson(input);
    expect(result.candidates.map((candidate) => candidate.value)).toEqual([{ a: { b: 1 } }, 'c']);
    expect(result.candidates[0]?.value).toEqual({ a: { b: 1 } });
    expect(result.candidates.every((candidate) => candidate.requiresConfirmation)).toBe(true);
    const repair = result.candidates[0]?.repairs.find((item) => item.reason === 'surplus-closing-bracket');
    expect(input[repair!.offset]).toBe('}');
    expect(result.errors).toHaveLength(2);
    const diagnostic = result.errors[0]!;
    expect(JSON.parse(diagnostic.message.split('): ')[1]!)).toContain('"c":2');
  }
  for (const input of ['```json\n{} } /* extra brace */ ]\n```', '```json\n[1]\n}\n```']) {
    const result = recoverJson(input);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.requiresConfirmation).toBe(true);
    expect(result.errors).toHaveLength(1);
  }
  const input = '{"a":1}}' + 'x'.repeat(1000);
  const result = recoverJson(input);
  const diagnostic = result.errors[0]!;
  expect(diagnostic.message).toContain('(truncated excerpt): ');
  expect(JSON.parse(diagnostic.message.split('): ')[1]!)).toBe(input.slice(diagnostic.offset, diagnostic.offset + 256));
  const fragments = recoverJson('[{"a":{"b":1}}},"c":2}]');
  expect(fragments.candidates[0]?.value).toEqual({ a: { b: 1 } });
  expect(fragments.candidates[0]?.requiresConfirmation).toBe(true);
  expect(fragments.errors[0]?.message).toBe('Mismatched closing bracket');
});

test('does not treat numbered prose or Markdown bullets as root scalar answers', () => {
  for (const prose of [
    '3 issues found. Details:',
    '3. issues found. Details:',
    '2) Here is my review',
    '2024. Summary',
    '- summary',
    '- **High**: crash',
    '- "quoted" thing',
    'true story follows:',
  ]) {
    const result = recoverJson(`${prose}\n\`\`\`json\n{"verdict":"confirmed"}\n\`\`\``);
    expect(result.candidates.map((candidate) => candidate.value)).toEqual([{ verdict: 'confirmed' }]);
  }
  expect(recoverJson(' 42 ').candidates[0]?.value).toBe(42);
  for (const prefix of ['', 'Score:\n']) {
    const negative = recoverJson(`${prefix}-5`);
    expect(negative.errors).toEqual([]);
    expect(negative.candidates).toHaveLength(1);
    expect(negative.candidates[0]?.value).toBe(-5);
    expect(negative.candidates[0]?.requiresConfirmation).toBe(false);
    const unfinished = recoverJson(`${prefix}-5x`).candidates[0]!;
    expect(unfinished.value).toBe('-5x');
    expect(unfinished.requiresConfirmation).toBe(true);
  }
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

test('bounds malformed input and never promotes rejected-document fragments to complete answers', () => {
  const nested = recoverJson('{] "nested": {"verdict":"refuted"}}').candidates[0]!;
  expect(nested.value).toEqual({ verdict: 'refuted' });
  expect(nested.requiresConfirmation).toBe(true);
  expect(recoverJson('x'.repeat(1_000_001)).errors).toHaveLength(1);
  const maximumValue = 'x'.repeat(999_998);
  const maximum = recoverJson(JSON.stringify(maximumValue));
  expect(maximum.errors).toEqual([]);
  expect(maximum.candidates).toHaveLength(1);
  expect(maximum.candidates[0]?.value).toBe(maximumValue);
  expect(maximum.candidates[0]?.repairs).toEqual([]);
  expect(maximum.candidates[0]?.requiresConfirmation).toBe(false);
  expect(recoverJson('['.repeat(130)).errors.length).toBeGreaterThan(0);
  expect(recoverJson('{}\n'.repeat(40)).candidates).toHaveLength(32);
  const capped = recoverJson(`${'{}\n'.repeat(40)}\`\`\`json\n{"verdict":"confirmed"}\n\`\`\``);
  expect(capped.candidates).toHaveLength(32);
  expect(capped.errors.some((error) => error.message.includes('candidate limit'))).toBe(true);
  const commentCap = recoverJson(`Notes: // ${'{} '.repeat(40)}\n{"last":true}`);
  expect(commentCap.candidates).toHaveLength(32);
  expect(commentCap.errors.some((error) => error.message.includes('candidate limit'))).toBe(true);
  const repeated = recoverJson(`${'{'.repeat(40)}\n\`\`\`json\n{"verdict":"confirmed"}\n\`\`\``);
  expect(repeated.errors.length).toBeGreaterThan(0);
  expect(repeated.errors.length).toBeLessThanOrEqual(32);
  expect(repeated.candidates.at(-1)?.value).toEqual({ verdict: 'confirmed' });
  const belowLimit = recoverJson(`${'{\n'.repeat(31)}{"verdict":"confirmed"}`);
  expect(belowLimit.candidates).toHaveLength(1);
  expect(belowLimit.candidates[0]?.value).toEqual({ verdict: 'confirmed' });
  expect(belowLimit.candidates[0]?.requiresConfirmation).toBe(true);
  expect(recoverJson(`${'{\n'.repeat(32)}{"verdict":"confirmed"}`).candidates).toEqual([]);
  const mixedBody = '"a", t\n{] \n'.repeat(20);
  const mixed = recoverJson(`\`\`\`json\n${mixedBody}\`\`\`\n\`\`\`json\n${mixedBody}\`\`\`\n`);
  expect(mixed.candidates).toHaveLength(32);
  expect(mixed.errors).toHaveLength(32);
  expect(mixed.errors.some((error) => error.message.includes('excerpt'))).toBe(true);
  expect(mixed.errors.some((error) => !error.message.includes('excerpt') && !error.message.includes('limit'))).toBe(
    true
  );
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
  for (const newline of ['\r', '\n', '\r\n']) {
    for (const marker of ['```', '~~~']) {
      const text = `${marker}json${newline}{"verdict":"confirmed"}${newline}${marker}${newline}`;
      const result = recoverJson(text);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.value).toEqual({ verdict: 'confirmed' });
      expect(result.candidates[0]?.start).toBe(text.indexOf('{'));
      expect(result.candidates[0]?.repairs).toEqual([]);
    }
  }
  const embedded = '{"explanation":"Use this:\n```js\nconst a = 1;\n```\nDone"}';
  for (const input of [embedded, `\`\`\`json\n${embedded}\n\`\`\``]) {
    const candidate = recoverJson(input).candidates[0]!;
    expect(candidate.value).toEqual({ explanation: 'Use this:\n```js\nconst a = 1;\n```\nDone' });
    expect(candidate.requiresConfirmation).toBe(true);
  }
  for (const json of ['{"verdict":"confirmed"}', '[1,2]', '"answer"']) {
    for (const separator of ['', ' ', '\t']) {
      for (const ending of ['', '\n```']) {
        expect(recoverJson(`\`\`\`json${separator}${json}${ending}`).candidates[0]?.value).toEqual(JSON.parse(json));
      }
    }
  }
  for (const scalar of ['true', '42']) {
    expect(recoverJson(`\`\`\`json ${scalar}`).candidates[0]?.value).toEqual(JSON.parse(scalar));
  }
  for (const value of ['true', '42', '"answer"', '{"v":2}']) {
    const result = recoverJson(`\`\`\`json\n${embedded}\n\`\`\`\n\`\`\`json\n${value}\n\`\`\``);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.requiresConfirmation).toBe(true);
    expect(result.candidates[1]?.value).toEqual(JSON.parse(value));
    expect(result.candidates[1]?.repairs).toEqual([]);
  }
});

test('retains contractions inside single-quoted strings without inventing fields or items', () => {
  for (const [input, expected] of [
    ["{'note':'it's fine'}", { note: "it's fine" }],
    ["['don't stop']", ["don't stop"]],
    ["{'note':'l'utilisateur'}", { note: "l'utilisateur" }],
    ["{'note':'version 2's behavior'}", { note: "version 2's behavior" }],
    ["['R2-D2's reply']", ["R2-D2's reply"]],
    ["['𐐀's reply']", ["𐐀's reply"]],
    [String.raw`['\u0061's reply']`, ["a's reply"]],
  ] as const) {
    const result = recoverJson(input);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.value).toEqual(expected);
    expect(result.candidates[0]?.requiresConfirmation).toBe(true);
    expect(result.candidates[0]?.repairs.some((repair) => repair.reason === 'literal-apostrophe')).toBe(true);
  }
});

test('retains structured answers adjacent to root keyword atoms', () => {
  for (const prefix of ['null', 'null;', 'true', 'false', '42']) {
    for (const json of ['{"verdict":"confirmed"}', '[1,2]']) {
      for (const text of [`${prefix}${json}`, `\`\`\`json\n${prefix}${json}\n\`\`\``]) {
        const result = recoverJson(text);
        expect(result.candidates).toHaveLength(2);
        expect(result.candidates[0]?.requiresConfirmation).toBe(true);
        expect(result.candidates[1]?.value).toEqual(JSON.parse(json));
      }
    }
  }
});

test('retains embedded quoted words without changing valid or missing-comma value boundaries', () => {
  for (const note of ['He said "hello" today', 'He said "42"', "He said 'hello' today"]) {
    const quote = note.includes('"') ? '"' : "'";
    for (const object of [true, false]) {
      const input = object ? `{${quote}note${quote}:${quote}${note}${quote}}` : `[${quote}${note}${quote}]`;
      const result = recoverJson(input);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.value).toEqual(object ? { note } : [note]);
      expect(result.candidates[0]?.requiresConfirmation).toBe(true);
    }
  }
  for (const next of ['1', 'true', 'null', '{"b":2}', '[2]', '"b"']) {
    const result = recoverJson(`["a" ${next}]`);
    expect(result.candidates[0]?.value).toEqual(['a', JSON.parse(next)]);
  }
  expect(recoverJson('{"a":"x" b:2}').candidates[0]?.value).toEqual({ a: 'x', b: 2 });
  for (const fenced of [false, true]) {
    const body = '{"summary":"He said "hi", then left","verdict":"confirmed"}';
    const result = recoverJson(fenced ? `\`\`\`json\n${body}\n\`\`\`` : body);
    expect(result.candidates[0]?.value).toEqual({ summary: 'He said "hi", then left', verdict: 'confirmed' });
    expect(result.candidates[0]?.requiresConfirmation).toBe(true);
  }
  expect(recoverJson('{"a":"x"y"b":"z"}').candidates[0]?.value).toEqual({ a: 'x', 'y"b"': 'z' });
  for (const prefix of [
    '{"note":"he said "hi"}',
    '["a"b"]',
    'text {"a":"x"b":"y"} tail',
    '{"a":"x"y", b:2}',
    '["x"y",2]',
    '{"a":"x"y","b":2}',
  ]) {
    for (const fenced of [false, true]) {
      const body = `${prefix} {"verdict":"confirmed"}`;
      const result = recoverJson(fenced ? `\`\`\`json\n${body}\n\`\`\`` : body);
      expect(result.candidates.at(-1)?.value).toEqual({ verdict: 'confirmed' });
      expect(result.candidates.at(-1)?.repairs).toEqual([]);
    }
  }
});

test('removes adjacent comments without incorporating them into keys or values', () => {
  for (const input of ['{a/*comment*/:1}', '{"a":1/*comment*/}', '{a//comment\n:1}', '{"a":1//comment\n}']) {
    const candidate = recoverJson(input).candidates[0]!;
    expect(candidate.value).toEqual({ a: 1 });
    expect(candidate.requiresConfirmation).toBe(false);
  }
  for (const [input, expected] of [
    ['{"a":"x"/*c*/"b":"y"}', { a: 'x', b: 'y' }],
    ['["x"/*x*/"y"]', ['x', 'y']],
  ] as const) {
    const candidate = recoverJson(input).candidates[0]!;
    expect(candidate.value).toEqual(expected);
    expect(candidate.requiresConfirmation).toBe(false);
  }
});

test('consumes leading comments before root detection and retains their provenance', () => {
  for (const prefix of ['// preface\n', '// preface\r', '/* {"not":"an answer"} */ ']) {
    for (const json of ['42', 'true', '"answer"', '{"a":1}', '[1]']) {
      for (const fenced of [false, true]) {
        const text = fenced ? `\`\`\`json\n${prefix}${json}\n\`\`\`` : prefix + json;
        const result = recoverJson(text);
        expect(result.candidates).toHaveLength(1);
        const candidate = result.candidates[0]!;
        expect(candidate.value).toEqual(JSON.parse(json));
        expect(candidate.start).toBe(text.indexOf(prefix));
        expect(
          candidate.repairs.some((repair) => repair.reason.endsWith('comment') && repair.offset === candidate.start)
        ).toBe(true);
        expect(candidate.requiresConfirmation).toBe(false);
      }
    }
  }
  const partial = recoverJson('/* incomplete {"not":"an answer"}');
  expect(partial.candidates).toEqual([]);
  expect(partial.errors.length).toBeGreaterThan(0);
});

test('keeps trailing comment examples out of candidates and marks ambiguous scalar-tail fragments', () => {
  const chain = recoverJson('42, tail\n{"a":1}\n{"b":2}\n{"c":3}');
  expect(chain.candidates.map((candidate) => candidate.value)).toEqual([42, { a: 1 }, { b: 2 }, { c: 3 }]);
  expect(chain.candidates.every((candidate) => candidate.requiresConfirmation)).toBe(true);
  for (const candidate of chain.candidates.slice(1)) {
    expect(candidate.repairs.some((repair) => repair.reason === 'fragment-after-ambiguous-scalar')).toBe(true);
  }
  const reset = recoverJson('42, tail\n{"a":1}\n```json\n{"b":2}\n```');
  expect(reset.candidates.map((candidate) => candidate.value)).toEqual([42, { a: 1 }, { b: 2 }]);
  expect(reset.candidates.at(-1)?.repairs).toEqual([]);
  expect(reset.candidates.at(-1)?.requiresConfirmation).toBe(false);
  for (const suffix of [' // not {"verdict":"refuted"}', ' /* {"verdict":"refuted"} */']) {
    const text = '{"verdict":"confirmed"}' + suffix;
    const result = recoverJson(text);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.value).toEqual({ verdict: 'confirmed' });
    expect(result.candidates[0]?.repairs.some((repair) => repair.reason.endsWith('comment'))).toBe(true);
    expect(result.candidates[0]?.end).toBe(text.length);
  }
  for (const input of ['"{"verdict":"confirmed","extra":{"n":1}}', '"["a",[1]]']) {
    const result = recoverJson(input);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((candidate) => candidate.requiresConfirmation)).toBe(true);
  }
  expect(recoverJson('{"a":1// comment\r,"b":2}').candidates[0]?.value).toEqual({ a: 1, b: 2 });
  expect(recoverJson('true\rExplanation').candidates[0]?.value).toBe(true);
});

test('retains only unconfirmed fragments from comment-like prose without mistaking scheme URLs for comments', () => {
  for (const input of [
    'My notes:\n// earlier the model reported {"verdict":"confirmed"}\nConclusion: it is refuted.',
    'Before it: // not {"verdict":"refuted"}',
    'My notes: /* earlier: {"verdict":"confirmed"} */',
    'My notes:\n/*\n{"verdict":"confirmed"}\n*/',
    'The operator a // b was used. Then: {"verdict":"confirmed"}',
    'He wrote "see // here" then {"verdict":"confirmed"}',
    'Path src//utils.ts then {"verdict":"confirmed"}',
    'See www.example.com/a//b then {"verdict":"confirmed"}',
  ]) {
    const candidates = recoverJson(input).candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.value).toEqual({ verdict: input.includes('refuted"') ? 'refuted' : 'confirmed' });
    expect(candidates[0]?.requiresConfirmation).toBe(true);
  }
  expect(recoverJson('Introduction:\n// ignore {"wrong":1}\r42').candidates.at(-1)?.value).toBe(42);
  const incomplete = recoverJson('My notes: /* unfinished {"verdict":"confirmed"}');
  expect(incomplete.candidates[0]?.value).toEqual({ verdict: 'confirmed' });
  expect(incomplete.candidates[0]?.requiresConfirmation).toBe(true);
  expect(incomplete.errors.length).toBeGreaterThan(0);
  const linked = recoverJson('See https://example.com/a//b/*c*/ before {"verdict":"confirmed"}');
  expect(linked.candidates).toHaveLength(1);
  expect(linked.candidates[0]?.value).toEqual({ verdict: 'confirmed' });
  expect(linked.candidates[0]?.repairs).toEqual([]);
  const bounded = 'Notes: /* ["cut */ "] {"verdict":"confirmed"}';
  const fragments = recoverJson(bounded).candidates;
  expect(fragments[0]?.end).toBeLessThanOrEqual(bounded.indexOf('"]'));
  expect(fragments[0]?.repairs.some((repair) => repair.kind === 'incomplete')).toBe(true);
  expect(fragments.at(-1)?.value).toEqual({ verdict: 'confirmed' });
  for (const prefix of ['packages/*/package.json', '.github/workflows/*.{yml,yaml}', 'src/*/index.ts']) {
    const result = recoverJson(`I checked ${prefix}.\n{"verdict":"refuted"}`);
    expect(result.candidates.at(-1)?.value).toEqual({ verdict: 'refuted' });
    expect(result.candidates.every((candidate) => candidate.requiresConfirmation)).toBe(true);
  }
  const globPaths = recoverJson('Check packages/*/index.ts and src/*/*.json then:\n```\n{"v":1}\n```');
  expect(globPaths.errors).toEqual([]);
  expect(globPaths.candidates).toHaveLength(1);
  expect(globPaths.candidates[0]?.value).toEqual({ v: 1 });
  for (const newline of ['\n', '\r', '\r\n']) {
    for (const value of [42, 'confirmed', true]) {
      const result = recoverJson(`Answer:${newline}/* stale */ ${JSON.stringify(value)}`);
      expect(result.errors).toEqual([]);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.value).toEqual(value);
      expect(result.candidates[0]?.requiresConfirmation).toBe(false);
    }
  }
  for (const prefix of ['- ', 'Verdict options:\n- ', '{"a":1}\n- ']) {
    for (const close of ['', '\n*/']) {
      const result = recoverJson(`${prefix}/* note\n{"verdict":"confirmed"}${close}`);
      expect(result.candidates.at(-1)?.value).toEqual({ verdict: 'confirmed' });
      expect(result.candidates.at(-1)?.requiresConfirmation).toBe(true);
      expect(result.errors.some((error) => error.message.includes('unterminated comment-like'))).toBe(close === '');
      if (prefix.startsWith('{')) expect(result.candidates[0]?.value).toEqual({ a: 1 });
    }
  }
  for (const input of ['- // note {"verdict":"confirmed"}\n', '1. /* {"verdict":"confirmed"} */ explanation']) {
    const result = recoverJson(input);
    expect(result.candidates.at(-1)?.value).toEqual({ verdict: 'confirmed' });
    expect(result.candidates.at(-1)?.requiresConfirmation).toBe(true);
    expect(result.errors).toEqual([]);
  }
  for (const boundary of [',', ']', '}', '},', '),']) {
    for (const comment of ['// note {"verdict":"confirmed"}\n', '/* {"verdict":"confirmed"} */ ']) {
      const candidates = recoverJson(`See https://x/a${boundary}${comment}{"answer":42}`).candidates;
      expect(candidates).toHaveLength(2);
      expect(candidates[0]?.value).toEqual({ verdict: 'confirmed' });
      expect(candidates[0]?.requiresConfirmation).toBe(true);
      expect(candidates[1]?.value).toEqual({ answer: 42 });
      expect(candidates[1]?.requiresConfirmation).toBe(false);
    }
  }
});

test('preserves apostrophes in comma continuations after embedded quoted words', () => {
  for (const continuation of ["then it's over", "then the model's answer", 'then it’s over']) {
    const result = recoverJson(`{"summary":"He said "hi", ${continuation}","verdict":"confirmed"}`);
    expect(result.candidates[0]?.value).toEqual({ summary: `He said "hi", ${continuation}`, verdict: 'confirmed' });
    expect(result.candidates[0]?.requiresConfirmation).toBe(true);
  }
  const single = recoverJson("{'summary':'He said 'hi', then it's over'}");
  expect(single.candidates[0]?.value).toEqual({ summary: "He said 'hi', then it's over" });
  expect(single.candidates[0]?.requiresConfirmation).toBe(true);
  for (const continuation of ['and {then} left', '-- then left']) {
    const candidate = recoverJson(`{"summary":"He said "hi", ${continuation}","verdict":"confirmed"}`).candidates[0]!;
    expect(candidate.value).toMatchObject({ summary: 'He said ', verdict: 'confirmed' });
    expect(candidate.requiresConfirmation).toBe(true);
  }
  const extraQuote = recoverJson('{"a":"He said "hi", then left"","v":1}').candidates[0]!;
  expect(extraQuote.value).toMatchObject({ a: 'He said ', v: 1 });
  expect(extraQuote.requiresConfirmation).toBe(true);
});

test('retains container answers abutting prose URLs without claiming independent boundaries', () => {
  const rootUri = recoverJson('https://x/{"a":1} tail {"b":2}');
  expect(rootUri.errors).toEqual([]);
  expect(rootUri.candidates.map((candidate) => candidate.value)).toEqual([{ a: 1 }, { b: 2 }]);
  expect(rootUri.candidates[0]?.repairs.some((repair) => repair.reason === 'ambiguous-uri-boundary')).toBe(true);
  expect(rootUri.candidates[0]?.requiresConfirmation).toBe(true);
  expect(rootUri.candidates[1]?.repairs).toEqual([]);
  expect(rootUri.candidates[1]?.requiresConfirmation).toBe(false);
  for (const prefix of ['See http://x/a', 'Link <https://x/a>', 'Link (https://x/a)']) {
    for (const fenced of [false, true]) {
      for (const json of ['{"a":1}', '[{"a":1}]']) {
        const body = prefix + json;
        const result = recoverJson(fenced ? `\`\`\`json\n${body}\n\`\`\`` : body);
        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0]?.value).toEqual(JSON.parse(json));
        expect(result.candidates[0]?.requiresConfirmation).toBe(true);
      }
    }
  }
  expect(recoverJson('See http://x/a{"a":1}{"b":2}').candidates.map((candidate) => candidate.value)).toEqual([
    { a: 1 },
    { b: 2 },
  ]);
  for (const uri of ['http://x/a[1]b[2]', 'https://example.com/api?f[1]=a&g[2]=b', 'https://x/a[1]b[2]c[3]']) {
    const candidates = recoverJson(`See ${uri} then {"answer":42}`).candidates;
    expect(candidates.slice(0, -1).map((candidate) => candidate.value)).toEqual(
      uri.endsWith('[3]') ? [[1], [2], [3]] : [[1], [2]]
    );
    expect(candidates.slice(0, -1).every((candidate) => candidate.requiresConfirmation)).toBe(true);
    expect(candidates.at(-1)?.value).toEqual({ answer: 42 });
    expect(candidates.at(-1)?.requiresConfirmation).toBe(false);
  }
  for (const uri of [
    'https://api.example.com/v1/{tenant}/items[2]',
    'http://x/a{1}[2]',
    'https://x/{id}?f[1]=a',
    'https://x/a[1]b{2}c[3]',
    'http://x/a{"a":1}{"b":2}',
    'http://x/a},[2]',
  ]) {
    const candidates = recoverJson(`See ${uri} then {"answer":42}`).candidates;
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.slice(0, -1).every((candidate) => candidate.requiresConfirmation)).toBe(true);
    expect(candidates.at(-1)?.value).toEqual({ answer: 42 });
    expect(candidates.at(-1)?.requiresConfirmation).toBe(false);
  }
});

test('bounds recovery work for long URI sequences and padded prose', () => {
  const links = 'http://x,'.repeat(100_000);
  const started = performance.now();
  expect(recoverJson(links)).toEqual({ candidates: [], errors: [] });
  for (const separator of ['', '\n']) {
    const result = recoverJson(`${links}${separator}{"verdict":"refuted"}`);
    expect(result.errors).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.value).toEqual({ verdict: 'refuted' });
    expect(result.candidates[0]?.requiresConfirmation).toBe(separator === '');
  }
  expect(recoverJson('1 x\n'.repeat(120_000) + ' '.repeat(519_999))).toEqual({ candidates: [], errors: [] });
  expect(performance.now() - started).toBeLessThan(5000);
});

test('rejects backticks in ordinary fence metadata without rejecting inline JSON payloads', () => {
  const partial = recoverJson('```json "cut off `x`').candidates;
  expect(partial).toHaveLength(1);
  expect(partial[0]?.value).toBe('cut off `x`');
  expect(partial[0]?.requiresConfirmation).toBe(true);
  expect(partial[0]?.repairs.some((repair) => repair.reason === 'unterminated-string')).toBe(true);
  for (const newline of ['\n', '\r', '\r\n']) {
    for (const marker of ['```', '````', '~~~']) {
      const result = recoverJson(`{]${newline}${marker} bad \` info${newline}{"verdict":"confirmed"}`);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.value).toEqual({ verdict: 'confirmed' });
      expect(result.candidates[0]?.requiresConfirmation).toBe(marker !== '~~~');
      expect(result.errors.length).toBeGreaterThan(0);
    }
    const inline = recoverJson(`\`\`\`json {"code":"\`foo\`"}${newline}\`\`\``);
    expect(inline.candidates).toHaveLength(1);
    expect(inline.candidates[0]?.value).toEqual({ code: '`foo`' });
    expect(inline.candidates[0]?.requiresConfirmation).toBe(false);
  }
});

test('retains independent ambiguity causes for LLM reconfirmation', () => {
  for (const [prefix, reason] of [
    ['{] ', 'fragment-after-rejected-document'],
    ['"x", trailing ', 'fragment-after-ambiguous-scalar'],
    ['Notes: // ', 'fragment-in-comment-like-prose'],
  ]) {
    const candidate = recoverJson(`${prefix}See http://x/a[1]`).candidates.at(-1);
    expect(candidate?.value).toEqual([1]);
    expect(candidate?.requiresConfirmation).toBe(true);
    expect(candidate?.repairs.map((repair) => repair.reason)).toEqual(
      expect.arrayContaining([reason, 'ambiguous-uri-boundary'])
    );
  }
});

test('salvages comma-separated scalars without reopening a scalar window inside prose', () => {
  for (const [input, values] of [
    ['"confirmed", "refuted"', ['confirmed', 'refuted']],
    ['1, 2, 3', [1, 2, 3]],
    ['{"a":1}, "confirmed"', [{ a: 1 }, 'confirmed']],
    [', 42', [42]],
  ] as const) {
    const candidates = recoverJson(input).candidates;
    expect(candidates.map((candidate) => candidate.value)).toEqual(values);
    if (!input.startsWith('{') && !input.startsWith(','))
      expect(candidates.every((candidate) => candidate.requiresConfirmation)).toBe(true);
  }
  expect(recoverJson('"a", prose "b"').candidates.map((candidate) => candidate.value)).toEqual(['a']);
  expect(recoverJson('Example, "not an answer"').candidates).toEqual([]);
});

test('retains bounded source context when an ambiguous quote boundary hides an answer', () => {
  const wrapped = '"{"verdict":"confirmed"}"';
  for (const input of [wrapped, `Answer:\n${wrapped}`, `\`\`\`json\n${wrapped}\n\`\`\``]) {
    const result = recoverJson(input);
    expect(result.candidates[0]?.value).toBe('{');
    expect(result.candidates[0]?.requiresConfirmation).toBe(true);
    expect(
      result.errors.some((error) => error.message.includes('verdict') && error.message.includes('confirmed'))
    ).toBe(true);
    expect(result.errors[0]?.offset).toBe(input.indexOf('verdict'));
  }
  const short = recoverJson(wrapped).errors[0]!;
  expect(short.message).toContain(' (excerpt): ');
  expect(JSON.parse(short.message.slice(short.message.indexOf('): ') + 3))).toBe(wrapped.slice(3));
  const tail = 'line\n'.repeat(1000);
  const large = recoverJson(`"{"${tail}`).errors[0]!;
  expect(large.message).toContain(' (truncated excerpt): ');
  expect(JSON.parse(large.message.slice(large.message.indexOf('): ') + 3))).toBe(tail.slice(0, 256));
  expect(recoverJson('"{literal}" // no ambiguity').errors).toEqual([]);
  expect(recoverJson('true; explanation').errors).toEqual([]);
  for (const newline of ['\n', '\r', '\r\n'])
    expect(recoverJson(`"confirmed"${newline}Explanation of the result.`).errors).toEqual([]);
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
    const withProse = recoverJson(`${JSON.stringify(value)} and then some prose`).candidates[0]!;
    expect(withProse.value).toBe(value);
    expect(withProse.requiresConfirmation).toBe(true);
  }
  const key = recoverJson('{"verdict”: "confirmed", "notes":"fine"}').candidates[0]!;
  expect(key.value).toEqual({ verdict: 'confirmed', notes: 'fine' });
  expect(key.requiresConfirmation).toBe(true);
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
  for (const json of ['"confirmed"', '42', 'true', 'null']) {
    const trailing = recoverJson(`\`\`\`json\n${json},\n\`\`\``).candidates[0]!;
    expect(trailing.value).toEqual(JSON.parse(json));
    expect(trailing.requiresConfirmation).toBe(true);
  }
  const adjacent = recoverJson('"a", "b"').candidates[0]!;
  expect(adjacent.value).toBe('a');
  expect(adjacent.requiresConfirmation).toBe(true);
  for (const [text, value] of [
    ['42 ✓', 42],
    ['true +1', true],
  ] as const) {
    const symbolic = recoverJson(text).candidates[0]!;
    expect(symbolic.value).toBe(value);
    expect(symbolic.requiresConfirmation).toBe(true);
    expect(symbolic.repairs.some((repair) => repair.reason === 'trailing-scalar-content')).toBe(true);
  }
  for (const token of ['true;', 'false:', 'null!', 'None…', 'True"', '42.']) {
    for (const text of [token, `\`\`\`json\n${token}\n\`\`\``]) {
      const literal = recoverJson(text).candidates[0]!;
      expect(literal.value).toBe(token);
      expect(literal.requiresConfirmation).toBe(true);
    }
    const explained = recoverJson(`${token} explanation`);
    if (token === '42.') expect(explained.candidates).toEqual([]);
    else expect(explained.candidates[0]?.value).toBe(token);
  }
  for (const [input, json] of [
    ['True', 'true'],
    ['False', 'false'],
    ['None', 'null'],
  ]) {
    const value = JSON.parse(json!);
    for (const text of [input!, `\`\`\`json\n${input}/*answer*/\n\`\`\``]) {
      const recovered = recoverJson(text).candidates[0]!;
      expect(recovered.value).toEqual(value);
      expect(recovered.requiresConfirmation).toBe(false);
    }
  }
});

test('recovers later standalone scalars through the same prose guards', () => {
  for (const json of ['42', '"confirmed"', 'true', 'None']) {
    const expected = JSON.parse(json === 'None' ? 'null' : json);
    for (const newline of ['\n', '\r', '\r\n']) {
      const multiple = recoverJson(`{"a":1}${newline}${json}`);
      expect(multiple.candidates.map((candidate) => candidate.value)).toEqual([{ a: 1 }, expected]);
      expect(recoverJson(`The answer is:${newline}  ${json}`).candidates[0]?.value).toEqual(expected);
      expect(
        recoverJson(`\`\`\`json${newline}Here is the answer:${newline}${json}${newline}\`\`\``).candidates[0]?.value
      ).toEqual(expected);
    }
  }
  expect(recoverJson('{"a":1} "b"').candidates.map((candidate) => candidate.value)).toEqual([{ a: 1 }, 'b']);
  for (const prefix of ['Result:\n```\n', 'Result:\n~~~\n', 'I ran:\n```bash\nls -la\n']) {
    expect(recoverJson(`${prefix}\`\`\`json\n42\n\`\`\``).candidates[0]?.value).toBe(42);
  }
  expect(recoverJson('Introduction:\n1. numbered prose\n- bullet\ntrue story').candidates).toEqual([]);
  expect(recoverJson('Introduction:\nordinary "quoted words" here').candidates).toEqual([]);
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

test('salvages only unconfirmed fragments after a structural rejection', () => {
  for (const prefix of [
    'Candidate 1: {[]}\nCandidate 2:',
    '{] "nested": {"verdict":"wrong"}}',
    '{"a": [} , "b": {"verdict":"wrong"}}',
    '{"a":[}, "url":https://example.com/a//b/*c*/ ]}',
    '{[] https://example.com }',
    '{"a":[}, notes":cut ]}',
    '{"a":[}, "key":"value” ]}',
    '{"a":[}, "v":foo[bar ]}',
  ]) {
    const result = recoverJson(`${prefix} {"verdict":"confirmed"}`);
    expect(result.candidates.at(-1)?.value).toEqual({ verdict: 'confirmed' });
    expect(result.errors.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(candidate.requiresConfirmation).toBe(true);
      expect(candidate.repairs.some((repair) => repair.reason === 'fragment-after-rejected-document')).toBe(true);
    }
    const fenced = recoverJson(`${prefix}\n\`\`\`json\n{"verdict":"confirmed"}\n\`\`\``).candidates.at(-1)!;
    expect(fenced.value).toEqual({ verdict: 'confirmed' });
    expect(fenced.requiresConfirmation).toBe(false);
  }
  const prose = recoverJson('See [PR-12: fix] for details: {"verdict":"confirmed"}');
  expect(prose.candidates).toHaveLength(2);
  expect(prose.candidates[0]?.requiresConfirmation).toBe(true);
  expect(prose.candidates[1]?.value).toEqual({ verdict: 'confirmed' });
});

test('treats ordinary Markdown info strings as metadata for every JSON root type', () => {
  for (const language of [
    'jsonc',
    'json5',
    'json42',
    'jsontrue',
    'json+ld',
    'json-lines',
    'json-ld',
    'json-c',
    'text',
    'javascript',
    'true',
    '42',
  ]) {
    for (const json of ['true', '42', '"answer"', '{"a":1}']) {
      const result = recoverJson(`\`\`\`${language}\n${json}\n\`\`\``);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.value).toEqual(JSON.parse(json));
      expect(result.candidates[0]?.repairs).toEqual([]);
    }
  }
});

test('keeps a truncated fenced answer separate from a following complete answer', () => {
  for (const json of ['{"verdict":"confirmed"}', '{"":"empty key"}', '["answer"]', 'true', '"answer"']) {
    const separate = recoverJson(`"unfinished\n\`\`\`json\n${json}\n\`\`\``).candidates;
    expect(separate).toHaveLength(2);
    expect(separate[0]?.value).toBe('unfinished\n');
    expect(separate[0]?.requiresConfirmation).toBe(true);
    expect(separate[1]?.value).toEqual(JSON.parse(json));
    expect(separate[1]?.repairs).toEqual([]);
  }
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
  for (const input of ['["a”, ]and more\n"tail', '["hi”, ]oops\ntail"tail', 'b["ea  -“n“]rax\nu"tail']) {
    const candidate = recoverJson(input).candidates[0]!;
    expect(candidate.requiresConfirmation).toBe(true);
    expect(candidate.repairs.some((repair) => repair.reason === 'unescaped-control-character')).toBe(false);
    for (const repair of candidate.repairs) {
      expect(repair.offset).toBeGreaterThanOrEqual(candidate.start);
      expect(repair.offset).toBeLessThanOrEqual(candidate.end);
    }
  }
});

test('preserves every emitted character of truncated strings containing smart quotations', () => {
  for (const quote of ['”', '’']) {
    const unclosed = recoverJson(`[${quote}] {"verdict":"confirmed"}`).candidates[0]!;
    expect(unclosed.value).toEqual(['] {"verdict":"confirmed"}']);
    expect(unclosed.requiresConfirmation).toBe(true);
  }
  const notes = 'The user said “I disagree”, and then left';
  for (let end = 0; end <= notes.length; end++) {
    for (const prefix of ['', '```json\n']) {
      const result = recoverJson(`${prefix}{"verdict":"refuted","notes":"${notes.slice(0, end)}`);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.value).toEqual({ verdict: 'refuted', notes: notes.slice(0, end) });
      expect(result.candidates[0]?.repairs.some((repair) => repair.reason === 'unterminated-string')).toBe(true);
      expect(result.candidates[0]?.requiresConfirmation).toBe(true);
    }
  }
});

test('does not treat unlike, shorter or over-indented fence markers as region boundaries', () => {
  for (const [fence, marker] of [
    ['```', '~~~'],
    ['````', '```'],
    ['```', '    ```'],
  ]) {
    const result = recoverJson(`${fence}json\n{"a":[1,\n${marker}\n{"verdict":"confirmed"}\n],"b":2}\n${fence}`);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.value).toEqual({ a: [1, marker!.trim(), { verdict: 'confirmed' }], b: 2 });
    expect(result.candidates[0]?.requiresConfirmation).toBe(true);
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

test('retains unquoted URL and time values without losing surrounding fields', () => {
  for (const value of [
    'https://example.com/a//b/*c*/',
    '12:30',
    'http://[::1]:8080/x',
    'http://example.com/api?filter[status]=active',
    'http://example.com/a[x[y]]',
    'http://es:9200/_search?q=age:[20,30]',
    'http://example.com/a[1,2]',
    'http://example.com/a?f[a,b]=1',
    'http://example.com/a?y=[1,2,3]',
  ]) {
    const candidate = recoverJson(`{"before":1,"value":${value},"after":2}`).candidates[0]!;
    expect(candidate.value).toEqual({ before: 1, value, after: 2 });
    expect(candidate.requiresConfirmation).toBe(true);
    expect(recoverJson(`[${value}]`).candidates[0]?.value).toEqual([value]);
  }
});
