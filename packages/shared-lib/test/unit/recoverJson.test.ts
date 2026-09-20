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
  expect(text.slice(repaired.start, repaired.end)).toBe('{verdict: "refuted",}\n');
  expect(repaired.repairs.some((repair) => text.slice(repair.offset).startsWith('verdict'))).toBe(true);
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
  expect(recoverJson('['.repeat(130)).errors.length).toBeGreaterThan(0);
  expect(recoverJson('{}\n'.repeat(40)).candidates).toHaveLength(32);
  const capped = recoverJson(`${'{}\n'.repeat(40)}\`\`\`json\n{"verdict":"confirmed"}\n\`\`\``);
  expect(capped.candidates).toHaveLength(32);
  expect(capped.errors.some((error) => error.message.includes('candidate limit'))).toBe(true);
  const repeated = recoverJson(`${'{'.repeat(40)}\n\`\`\`json\n{"verdict":"confirmed"}\n\`\`\``);
  expect(repeated.errors.length).toBeGreaterThan(0);
  expect(repeated.errors.length).toBeLessThanOrEqual(32);
  expect(repeated.candidates.at(-1)?.value).toEqual({ verdict: 'confirmed' });
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
