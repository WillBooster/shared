import { describe, expect, it } from 'vitest';

import { normalizeArgs, type ScriptArgv } from '../../../src/scripts/builder.js';

describe('normalizeArgs', () => {
  it('escapes shell-sensitive arguments', () => {
    const argv = {
      _: ['start', `semi;colon`, `quo'te`, `double"quote`],
      args: ['space value'],
      '--': ['--host', '0.0.0.0', `quo'te`],
      dockerOptions: [`name=quo'ted`],
    } as unknown as ScriptArgv;

    normalizeArgs(argv);

    expect(argv.normalizedArgsText).toBe(
      String.raw`'space value' 'semi;colon' 'quo'\''te' 'double"quote' --host 0.0.0.0 'quo'\''te'`
    );
    expect(argv.normalizedDockerOptionsText).toBe(String.raw`'name=quo'\''ted'`);
  });
});
