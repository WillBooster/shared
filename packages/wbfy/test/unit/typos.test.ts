import { expect, test } from 'vitest';

import { fixTyposInCode, fixTyposInText } from '../../src/fixers/typos.js';

test('fixTyposInText normalizes abbreviation typos without touching regular words', () => {
  expect(fixTyposInText('eg. one, ie. two, c.f. three')).toBe('e.g. one, i.e. two, cf. three');
  expect(fixTyposInText('the cookie. crumbles')).toBe('the cookie. crumbles');
  expect(fixTyposInText('my leg. hurts')).toBe('my leg. hurts');
});

test('line-comment typo fixes keep words merely ending in the abbreviation letters intact', () => {
  // Regression: "// ... cookie." used to become "// ... cooki.e." because the pattern
  // lacked a word boundary (observed in agent-challenges src/db/schema.ts).
  expect(fixTyposInCode('// stores the session cookie.\n')).toBe('// stores the session cookie.\n');
  expect(fixTyposInCode('// the left leg. moves\n')).toBe('// the left leg. moves\n');
  expect(fixTyposInCode('// values, eg. one\n')).toBe('// values, e.g. one\n');
  expect(fixTyposInCode('// values, ie. one\n')).toBe('// values, i.e. one\n');
  expect(fixTyposInCode('/* block e.g. one */')).toBe('/* block e.g. one */');
});
