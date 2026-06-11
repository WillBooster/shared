import { expect, test } from 'vitest';

import { parseCommandLineArgs } from '../src/parseCommandLineArgs.js';

test('parseCommandLineArgs splits a command string into arguments', () => {
  expect(parseCommandLineArgs('--flag=value -f value --option="quoted value"')).toEqual([
    '--flag=value',
    '-f',
    'value',
    '--option=quoted value',
  ]);
});

test('parseCommandLineArgs preserves quoted argument text', () => {
  expect(parseCommandLineArgs('arg1 \'single quoted\' "double quoted" arg4')).toEqual([
    'arg1',
    'single quoted',
    'double quoted',
    'arg4',
  ]);
});

test('parseCommandLineArgs ignores empty space-only arguments', () => {
  expect(parseCommandLineArgs(' arg1  arg2   arg3 ')).toEqual(['arg1', 'arg2', 'arg3']);
  expect(parseCommandLineArgs('   ')).toEqual([]);
  expect(parseCommandLineArgs('')).toEqual([]);
});
