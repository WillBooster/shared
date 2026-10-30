import { describe, expect, it } from 'bun:test';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDartFormatCommand,
  buildDartLintCommand,
  buildLintCommand,
  buildPoetryFormatCommand,
  buildPoetryLintCommand,
  getExplicitLintTargets,
  getLintTargetFileKind,
  getLintTargetFiles,
} from '../../src/commands/lint.js';
import { createTempDir } from '../helpers/shared.js';

const cliPath = fileURLToPath(new URL('../../src/index.ts', import.meta.url));

describe('lint', () => {
  it('builds an oxlint command for oxlint projects', () => {
    expect(
      buildLintCommand({ preferredLinter: 'oxlint', hasTypeAwareOxlint: false }, { fix: true, format: false }, [
        '/tmp/example.ts',
      ])
    ).toBe('YARN oxlint --no-error-on-unmatched-pattern --fix /tmp/example.ts');
  });

  it('uses the current directory when oxlint runs without explicit files', () => {
    expect(
      buildLintCommand({ preferredLinter: 'oxlint', hasTypeAwareOxlint: false }, { fix: false, format: false })
    ).toBe('YARN oxlint --no-error-on-unmatched-pattern .');
  });

  it('passes type-aware flags when oxlint-tsgolint is available', () => {
    expect(
      buildLintCommand({ preferredLinter: 'oxlint', hasTypeAwareOxlint: true }, { fix: false, format: false })
    ).toBe('YARN oxlint --no-error-on-unmatched-pattern --type-aware --type-check .');
  });

  it('builds poetry commands for explicit python files', () => {
    expect(buildPoetryFormatCommand(['/tmp/example.py'])).toBe(
      'poetry run isort --profile black --filter-files /tmp/example.py && poetry run black /tmp/example.py'
    );
    expect(buildPoetryLintCommand({}, ['/tmp/example.py'])).toBe('poetry run flake8 /tmp/example.py');
  });

  it('builds dart commands for explicit dart files', () => {
    expect(buildDartFormatCommand(['/tmp/example.dart'])).toBe('dart format /tmp/example.dart');
    expect(buildDartLintCommand(['/tmp/example.dart'])).toBe('dart analyze /tmp/example.dart');
  });

  it('escapes shell-sensitive file paths', () => {
    expect(
      buildLintCommand({ preferredLinter: 'oxlint', hasTypeAwareOxlint: false }, { fix: false, format: false }, [
        '/tmp/evil"file.ts',
      ])
    ).toBe(`YARN oxlint --no-error-on-unmatched-pattern '/tmp/evil"file.ts'`);
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

    expect(getLintTargetFileKind(dirPath)).resolves.toBe('directory');
  });

  it('does not treat regular files as directories', async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-lint-file-'));
    const filePath = path.join(dirPath, 'README.md');

    await fs.writeFile(filePath, '# test\n');

    expect(getLintTargetFileKind(filePath)).resolves.toBe('other');
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
    ).toEqual<unknown>([
      { lintPath: '/repo/packages/a', project: { dirPath: '/repo/packages/a', preferredLinter: 'oxlint' } },
      { lintPath: '/repo/packages/b', project: { dirPath: '/repo/packages/b', preferredLinter: 'oxlint' } },
    ]);
  });

  it('formats a worktree nested in a checkout without loading the formatter config of the checkout', async () => {
    const parentPath = createTempDir();
    const git = (...args: string[]): void => {
      childProcess.execFileSync('git', ['-c', 'user.name=wb', '-c', 'user.email=wb@example.com', ...args], {
        cwd: parentPath,
      });
    };
    git('init', '-q', '-b', 'main');
    await fs.writeFile(path.join(parentPath, 'package.json'), '{ "name": "repo", "private": true }\n');
    await fs.writeFile(path.join(parentPath, 'bunfig.toml'), '[fmt]\nsingleQuote = true\n');
    await fs.writeFile(path.join(parentPath, 'a.ts'), "const a = 'x';\n");
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const worktreePath = path.join(parentPath, '.tmp', 'worktree');
    git('worktree', 'add', '-q', '-b', 'feature', worktreePath);
    // The checkout stays on a branch whose config imports a package that is not installed.
    await fs.writeFile(
      path.join(parentPath, 'oxfmt.config.ts'),
      "import config from '@willbooster/oxfmt-config';\nexport default config;\n"
    );
    await fs.writeFile(path.join(worktreePath, 'a.ts'), 'const a = "x";\n');

    const result = childProcess.spawnSync(
      'bun',
      [cliPath, '--working-dir', worktreePath, 'lint', '--format', '--', 'a.ts'],
      { encoding: 'utf8' }
    );

    expect(result.stdout + result.stderr).not.toContain('oxfmt.config.ts');
    expect(result.status).toBe(0);
    expect(await fs.readFile(path.join(worktreePath, 'a.ts'), 'utf8')).toBe("const a = 'x';\n");
  });
});
