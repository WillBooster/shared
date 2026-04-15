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
  it('builds an oxlint command for oxlint projects', () => {
    expect(buildLintCommand({ preferredLinter: 'oxlint' }, { fix: true, format: false }, ['/tmp/example.ts'])).toBe(
      'YARN oxlint --fix /tmp/example.ts'
    );
  });

  it('uses the current directory when oxlint runs without explicit files', () => {
    expect(buildLintCommand({ preferredLinter: 'oxlint' }, { fix: false, format: false })).toBe('YARN oxlint .');
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
      `YARN oxfmt --write --no-error-on-unmatched-pattern -c "$(node -e 'console.log(require.resolve("@willbooster/oxfmt-config"))')" /tmp/example.ts`
    );
  });

  it('escapes shell-sensitive file paths', () => {
    expect(buildLintCommand({ preferredLinter: 'oxlint' }, { fix: false, format: false }, ['/tmp/evil"file.ts'])).toBe(
      `YARN oxlint '/tmp/evil"file.ts'`
    );
  });

  it('keeps prettier args to prettier-only formats for oxlint projects', () => {
    expect(
      buildPrettierArgs('/repo', [
        { dirPath: '/repo/packages/oxlint-app', preferredLinter: 'oxlint', hasOxfmt: false },
        { dirPath: '/repo/packages/oxfmt-app', preferredLinter: 'oxlint', hasOxfmt: true },
      ])
    ).toEqual([
      '**/{.*/,}*.{java}',
      '!**/test{-,/}fixtures/**',
      'packages/oxlint-app/**/{.*/,}*.{cjs,css,cts,htm,html,java,js,json,json5,jsonc,jsx,md,mjs,mts,scss,ts,tsx,vue,yaml,yml}',
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

  it('keeps prettier formatting only for prettier-only files without oxfmt', () => {
    expect(shouldFormatExplicitPathWithPrettier({ preferredLinter: 'oxlint', hasOxfmt: false }, 'java')).toBe(true);
    expect(shouldFormatExplicitPathWithPrettier({ preferredLinter: 'oxlint', hasOxfmt: false }, 'md')).toBe(true);
  });

  it('prefers oxfmt formatting when available', () => {
    expect(shouldFormatExplicitPathWithPrettier({ preferredLinter: 'oxlint', hasOxfmt: true }, 'ts')).toBe(true);
    expect(shouldFormatExplicitPathWithPrettier({ preferredLinter: 'oxlint', hasOxfmt: true }, 'py')).toBe(false);
  });

  it('keeps explicit files unchanged in prettier args', () => {
    expect(
      buildExplicitFormatterArgs(
        { preferredLinter: 'oxlint', hasOxfmt: false },
        '/tmp/example/README.md',
        'other',
        'md'
      )
    ).toEqual(['/tmp/example/README.md']);
  });

  it('keeps fixture ignores for explicit oxlint directories without oxfmt', () => {
    expect(
      buildExplicitFormatterArgs({ preferredLinter: 'oxlint', hasOxfmt: false }, '/tmp/example', 'directory', '')
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
          { dirPath: '/repo', preferredLinter: 'oxlint' },
          { dirPath: '/repo/packages/a', preferredLinter: 'oxlint' },
          { dirPath: '/repo/packages/b', preferredLinter: 'oxlint' },
        ] as never,
        '/repo/packages',
        'directory'
      )
    ).toEqual([
      { lintPath: '/repo/packages/a', project: { dirPath: '/repo/packages/a', preferredLinter: 'oxlint' } },
      { lintPath: '/repo/packages/b', project: { dirPath: '/repo/packages/b', preferredLinter: 'oxlint' } },
    ]);
  });
});
