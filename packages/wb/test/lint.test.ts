import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildDartCommand,
  buildExplicitFormatterArgs,
  buildLintCommand,
  buildOxfmtCommand,
  buildPoetryCommand,
  buildPrettierArgs,
  getExplicitLintTargets,
  getLintTargetFileKind,
  getLintTargetFiles,
  getExplicitPackageJsonPaths,
  shouldFormatExplicitPathWithPrettier,
} from '../src/commands/lint.js';

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

  it('builds an oxlint command for oxlint projects', () => {
    expect(buildLintCommand({ preferredLinter: 'oxlint' }, { fix: true, format: false }, ['/tmp/example.ts'])).toBe(
      'YARN oxlint --fix /tmp/example.ts'
    );
  });

  it('uses the current directory when eslint runs without explicit files', () => {
    expect(buildLintCommand({ preferredLinter: 'eslint' }, { fix: false, format: false })).toBe(
      'YARN eslint --color -- .'
    );
  });

  it('builds poetry commands for explicit python files', () => {
    expect(buildPoetryCommand({ fix: true, format: true }, ['/tmp/example.py'])).toBe(
      'poetry run isort --profile black --filter-files /tmp/example.py && poetry run black /tmp/example.py && poetry run flake8 /tmp/example.py'
    );
  });

  it('builds dart commands for explicit dart files', () => {
    expect(buildDartCommand({ fix: true, format: true }, ['/tmp/example.dart'])).toBe(
      'dart format /tmp/example.dart && dart analyze /tmp/example.dart'
    );
  });

  it('builds an oxfmt command for explicit files', () => {
    expect(buildOxfmtCommand(['/tmp/example.ts'])).toBe(
      'YARN oxfmt --write --no-error-on-unmatched-pattern /tmp/example.ts'
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
        { dirPath: '/repo/packages/eslint-app', preferredLinter: 'eslint', hasOxfmt: false },
        { dirPath: '/repo/packages/biome-app', preferredLinter: 'biome', hasOxfmt: false },
      ])
    ).toEqual([
      '**/{.*/,}*.{java,md,scss}',
      '!**/test{-,/}fixtures/**',
      'packages/eslint-app/**/{.*/,}*.{cjs,css,cts,htm,html,java,js,json,json5,jsonc,jsx,md,mjs,mts,scss,ts,tsx,vue,yaml,yml}',
    ]);
  });

  it('accepts lint target files passed after --', () => {
    expect(
      getLintTargetFiles({
        _: ['lint', 'skills/complete-pr/SKILL.md'],
        files: undefined,
      })
    ).toEqual(['skills/complete-pr/SKILL.md']);
  });

  it('merges positional and double-dash lint targets and preserves numeric paths', () => {
    expect(
      getLintTargetFiles({
        _: ['lint', 'double-dash.ts', 123],
        '--': ['double-dash.ts', 456],
        files: ['positional.ts', 123],
      })
    ).toEqual(['positional.ts', '123', 'double-dash.ts', '456']);
  });

  it('treats explicit directories as lint targets', async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-lint-dir-'));

    await expect(getLintTargetFileKind(dirPath)).resolves.toBe('directory');
  });

  it('does not treat regular files as directories', async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-lint-file-'));
    const filePath = path.join(dirPath, 'README.md');

    await fs.writeFile(filePath, '# test\n');

    await expect(getLintTargetFileKind(filePath)).resolves.toBe('other');
  });

  it('keeps prettier formatting for explicit markdown files in biome projects', () => {
    expect(shouldFormatExplicitPathWithPrettier({ preferredLinter: 'biome', hasOxfmt: false }, 'md')).toBe(true);
    expect(shouldFormatExplicitPathWithPrettier({ preferredLinter: 'biome', hasOxfmt: false }, 'ts')).toBe(false);
  });

  it('prefers oxfmt formatting when available', () => {
    expect(shouldFormatExplicitPathWithPrettier({ preferredLinter: 'oxlint', hasOxfmt: true }, 'ts')).toBe(true);
    expect(shouldFormatExplicitPathWithPrettier({ preferredLinter: 'oxlint', hasOxfmt: true }, 'py')).toBe(false);
  });

  it('uses a prettier-only glob for explicit directories in biome projects', () => {
    expect(
      buildExplicitFormatterArgs({ preferredLinter: 'biome', hasOxfmt: false }, '/tmp/example', 'directory', '')
    ).toEqual(['/tmp/example/**/{.*/,}*.{java,md,scss}', '!**/test{-,/}fixtures/**']);
  });

  it('keeps explicit files unchanged in prettier args', () => {
    expect(
      buildExplicitFormatterArgs({ preferredLinter: 'biome', hasOxfmt: false }, '/tmp/example/README.md', 'other', 'md')
    ).toEqual(['/tmp/example/README.md']);
  });

  it('keeps fixture ignores for explicit eslint directories', () => {
    expect(
      buildExplicitFormatterArgs({ preferredLinter: 'eslint', hasOxfmt: false }, '/tmp/example', 'directory', '')
    ).toEqual(['/tmp/example', '!**/test{-,/}fixtures/**']);
  });

  it('uses direct directory formatting for oxfmt projects', () => {
    expect(
      buildExplicitFormatterArgs({ preferredLinter: 'oxlint', hasOxfmt: true }, '/tmp/example', 'directory', '')
    ).toEqual(['/tmp/example']);
  });

  it('collects package.json files underneath explicit directories', () => {
    expect(
      getExplicitPackageJsonPaths(
        [
          { dirPath: '/repo', packageJsonPath: '/repo/package.json' },
          { dirPath: '/repo/packages/a', packageJsonPath: '/repo/packages/a/package.json' },
          { dirPath: '/repo/packages/b', packageJsonPath: '/repo/packages/b/package.json' },
        ],
        '/repo/packages',
        'directory'
      )
    ).toEqual(['/repo/packages/a/package.json', '/repo/packages/b/package.json']);
  });

  it('fans out parent directory targets to descendant projects', () => {
    expect(
      getExplicitLintTargets(
        [
          { dirPath: '/repo', preferredLinter: 'eslint' },
          { dirPath: '/repo/packages/a', preferredLinter: 'eslint' },
          { dirPath: '/repo/packages/b', preferredLinter: 'biome' },
        ] as never,
        '/repo/packages',
        'directory'
      )
    ).toEqual([
      { lintPath: '/repo/packages/a', project: { dirPath: '/repo/packages/a', preferredLinter: 'eslint' } },
      { lintPath: '/repo/packages/b', project: { dirPath: '/repo/packages/b', preferredLinter: 'biome' } },
    ]);
  });
});
