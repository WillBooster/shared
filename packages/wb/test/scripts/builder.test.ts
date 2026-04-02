import { describe, expect, it } from 'vitest';

import { normalizeArgs, type ScriptArgv } from '../../src/scripts/builder.js';

describe('normalizeArgs', () => {
  it('escapes shell-sensitive arguments', () => {
    const argv = {
      _: ['start', `semi;colon`, `quo'te`, `double"quote`],
      args: ['space value'],
      dockerOptions: [`name=quo'ted`],
    } as unknown as ScriptArgv;

    normalizeArgs(argv);

    expect(argv.normalizedArgsText).toBe(`'space value' 'semi;colon' 'quo'"'"'te' 'double"quote'`);
    expect(argv.normalizedDockerOptionsText).toBe(`'name=quo'"'"'ted'`);
  });
});
