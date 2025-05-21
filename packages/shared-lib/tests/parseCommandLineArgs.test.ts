import { expect, test } from 'vitest';

import { parseCommandLineArgs } from '../src/parseCommandLineArgs.js';

test('parseCommandLineArgs with empty string', () => {
  expect(parseCommandLineArgs('')).toEqual([]);
});

test('parseCommandLineArgs with simple arguments', () => {
  expect(parseCommandLineArgs('arg1 arg2 arg3')).toEqual(['arg1', 'arg2', 'arg3']);
});

test('parseCommandLineArgs with double-quoted strings', () => {
  expect(parseCommandLineArgs('arg1 "quoted arg" arg3')).toEqual(['arg1', 'quoted arg', 'arg3']);
});

test('parseCommandLineArgs with single-quoted strings', () => {
  expect(parseCommandLineArgs("arg1 'quoted arg' arg3")).toEqual(['arg1', 'quoted arg', 'arg3']);
});

test('parseCommandLineArgs with mixed quotes', () => {
  expect(parseCommandLineArgs('arg1 \'single quoted\' "double quoted" arg4')).toEqual([
    'arg1',
    'single quoted',
    'double quoted',
    'arg4',
  ]);
});

test('parseCommandLineArgs with consecutive spaces', () => {
  expect(parseCommandLineArgs('arg1  arg2   arg3')).toEqual(['arg1', 'arg2', 'arg3']);
});

test('parseCommandLineArgs with leading and trailing spaces', () => {
  expect(parseCommandLineArgs(' arg1 arg2 arg3 ')).toEqual(['arg1', 'arg2', 'arg3']);
});

test('parseCommandLineArgs with special characters', () => {
  expect(parseCommandLineArgs('--flag=value -f value --option="quoted value"')).toEqual([
    '--flag=value',
    '-f',
    'value',
    '--option=quoted value',
  ]);
});
