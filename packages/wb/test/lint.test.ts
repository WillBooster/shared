import { describe, expect, it } from 'vitest';

import { buildLintCommand, buildPrettierArgs } from '../src/commands/lint.js';

describe('lint', () => {
  it('builds a biome command for biome projects', () => {
    expect(buildLintCommand({ preferredLinter: 'biome' }, { fix: true, format: true }, ['/tmp/example.ts'])).toBe(
      'BUN biome check --fix --colors=force --no-errors-on-unmatched --files-ignore-unknown=true -- /tmp/example.ts'
    );
  });

  it('builds an eslint command for eslint projects', () => {
    expect(buildLintCommand({ preferredLinter: 'eslint' }, { fix: false, format: true }, ['/tmp/example.ts'])).toBe(
      'YARN eslint --color --fix -- /tmp/example.ts'
    );
  });

  it('uses the current directory when eslint runs without explicit files', () => {
    expect(buildLintCommand({ preferredLinter: 'eslint' }, { fix: false, format: false })).toBe(
      'YARN eslint --color -- .'
    );
  });

  it('escapes shell-sensitive file paths', () => {
    expect(buildLintCommand({ preferredLinter: 'eslint' }, { fix: false, format: false }, ['/tmp/evil"file.ts'])).toBe(
      `YARN eslint --color -- '/tmp/evil"file.ts'`
    );
  });

  it('includes eslint project files in prettier args', () => {
    expect(
      buildPrettierArgs('/repo', [
        { dirPath: '/repo/packages/eslint-app', preferredLinter: 'eslint' },
        { dirPath: '/repo/packages/biome-app', preferredLinter: 'biome' },
      ])
    ).toEqual([
      '**/{.*/,}*.{java,md,scss}',
      '!**/test{-,/}fixtures/**',
      'packages/eslint-app/**/{.*/,}*.{cjs,css,cts,htm,html,java,js,json,json5,jsonc,jsx,md,mjs,mts,scss,ts,tsx,vue,yaml,yml}',
    ]);
  });
});
