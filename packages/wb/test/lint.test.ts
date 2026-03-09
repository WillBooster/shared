import { describe, expect, it } from 'vitest';

import { buildLintCommand } from '../src/commands/lint.js';

describe('lint', () => {
  it('builds a biome command for biome projects', () => {
    expect(buildLintCommand({ preferredLinter: 'biome' }, { fix: true, format: true }, ['/tmp/example.ts'])).toBe(
      'bun --bun biome check --fix --colors=force --no-errors-on-unmatched --files-ignore-unknown=true "/tmp/example.ts"'
    );
  });

  it('builds an eslint command for eslint projects', () => {
    expect(buildLintCommand({ preferredLinter: 'eslint' }, { fix: false, format: true }, ['/tmp/example.ts'])).toBe(
      'bun --bun eslint --color --fix "/tmp/example.ts"'
    );
  });

  it('uses the current directory when eslint runs without explicit files', () => {
    expect(buildLintCommand({ preferredLinter: 'eslint' }, { fix: false, format: false })).toBe(
      'bun --bun eslint --color .'
    );
  });
});
