import { test, expect } from 'vitest';

import { fixTyposInText } from '../src/fixers/typos.js';

test.each([
  { input: 'This is c.f. an example', expected: 'This is cf. an example' },
  { input: 'eg. this is another example', expected: 'e.g. this is another example' },
  { input: 'ie. a final example', expected: 'i.e. a final example' },
  { input: 'c.f. ,eg. ie.', expected: 'cf. ,e.g. ie.' },
  { input: 'apple pie.', expected: 'apple pie.' },
  { input: 'peg.', expected: 'peg.' },
])('fixAbbreviationsInText', ({ expected, input }) => {
  expect(fixTyposInText(input)).toEqual(expected);
});
