import { describe, expect, it } from 'bun:test';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTempDir } from '../helpers/shared.js';

const cliPath = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const malformed = '---\nname: example\ndescription: Reject verdict: fail\n---\n\n# Instructions\n';
const valid = '---\nname: example\ndescription: >-\n  Reject verdict: fail\n---\n\nBody: [not YAML\n';

describe('lint skill frontmatter', () => {
  it('rejects malformed YAML with a file diagnostic and accepts its corrected block scalar', async () => {
    const dir = await createSkillProject({ 'skills/example/SKILL.md': malformed });
    const result = runLint(dir);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('skills/example/SKILL.md');
    expect(result.stdout + result.stderr).toContain('Nested mappings');

    await fs.writeFile(path.join(dir, 'skills/example/SKILL.md'), valid);
    expect(runLint(dir).status).toBe(0);
    await fs.writeFile(path.join(dir, 'skills/example/SKILL.md'), valid.replaceAll('---\n', '--- \t\r\n'));
    expect(runLint(dir).status).toBe(0);
    expect(runLint(dir, ['skills/']).status).toBe(0);
  });

  it('rejects unresolved and forward aliases but accepts an anchor preceding its alias', async () => {
    const dir = await createSkillProject({ 'skills/example/SKILL.md': valid });
    const file = path.join(dir, 'skills/example/SKILL.md');
    for (const metadata of [
      'name: example\ndescription: *description\n',
      'name: example\ndescription: *description\nsummary: &description Example\n',
    ]) {
      await fs.writeFile(file, `---\n${metadata}---\n# Instructions\n`);
      const result = runLint(dir);
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain('Unresolved alias');
      expect(result.stdout + result.stderr).toContain('skills/example/SKILL.md');
    }
    await fs.writeFile(file, '---\nname: example\nsummary: &description Example\ndescription: *description\n---\n');
    expect(runLint(dir).status).toBe(0);
  });

  it('restricts explicit file and directory runs and ignores fixtures and ignored skills', async () => {
    const dir = await createSkillProject({
      'skills/good/SKILL.md': valid,
      '.claude/skills/bad/SKILL.md': malformed,
      'test/fixtures/sample/SKILL.md': malformed,
      'ignored/SKILL.md': malformed,
    });
    await fs.writeFile(path.join(dir, '.gitignore'), 'ignored/\n');
    expect(runLint(dir, ['skills/good/SKILL.md']).status).toBe(0);
    expect(runLint(dir, ['skills']).status).toBe(0);
    const result = runLint(dir, ['.claude']);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('.claude/skills/bad/SKILL.md');
    await fs.rm(path.join(dir, '.claude'), { recursive: true });
    expect(runLint(dir).status).toBe(0);
  });

  it('honors repository-local and configured Git exclusions', async () => {
    const dir = await createSkillProject({
      'skills/good/SKILL.md': valid,
      '.claude/skills/local/SKILL.md': malformed,
      '.agents/skills/local/SKILL.md': malformed,
      'apps/example/package.json': '{"name":"nested-skill-example","private":true}',
      'apps/example/.claude/skills/local/SKILL.md': malformed,
      'apps/example/skills/good/SKILL.md': valid,
    });
    childProcess.execFileSync('git', ['init', '-q'], { cwd: dir });
    await fs.writeFile(path.join(dir, '.git/info/exclude'), '.claude/\n');
    const excludes = path.join(dir, '.git/global-ignore');
    await fs.writeFile(excludes, '.agents/\n');
    childProcess.execFileSync('git', ['config', 'core.excludesFile', excludes], { cwd: dir });
    expect(runLint(dir).status).toBe(0);
    expect(runLint(dir, ['.claude']).status).toBe(0);
    expect(runLint(path.join(dir, 'apps/example')).status).toBe(0);
  });

  it('keeps submodule skills outside parent lint while validating them in their own project', async () => {
    const source = await createSkillProject({ 'SKILL.md': malformed });
    const dir = await createSkillProject({ 'own/SKILL.md': valid });
    git(source, 'init', '-q');
    git(source, 'add', '.');
    git(source, '-c', 'user.name=wb', '-c', 'user.email=wb@example.com', 'commit', '-qm', 'fixture');
    git(dir, 'init', '-q');
    for (const submodule of ['.claude/skills', 'packages/skills']) {
      git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, submodule);
      expect(runLint(dir).status).toBe(0);
      expect(runLint(dir, ['own/SKILL.md']).status).toBe(0);
      for (const args of [[], ['SKILL.md']]) {
        const result = runLint(path.join(dir, submodule), args);
        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain('invalid skill frontmatter');
      }
    }
    const embedded = path.join(dir, 'packages/embedded');
    await fs.cp(source, embedded, { recursive: true });
    expect(runLint(embedded).status).toBe(1);
    expect(runLint(embedded, ['SKILL.md']).status).toBe(1);
  }, 20_000);

  it('preserves dependency and temporary exclusions for explicit directory and file targets', async () => {
    for (const withGit of [false, true]) {
      const dir = await createSkillProject({
        'skills/good/SKILL.md': valid,
        'node_modules/pkg/SKILL.md': malformed,
        '.tmp/SKILL.md': malformed,
      });
      if (withGit) {
        git(dir, 'init', '-q');
        await fs.mkdir(path.join(dir, '.git/local'));
        await fs.writeFile(path.join(dir, '.git/local/SKILL.md'), malformed);
      }
      const targets = ['node_modules', 'node_modules/pkg/SKILL.md', '.tmp', '.tmp/SKILL.md'];
      if (withGit) targets.push('.git', '.git/local/SKILL.md');
      for (const target of targets) {
        const result = runLint(dir, [target]);
        expect(result.stdout + result.stderr).not.toContain('invalid skill frontmatter');
        expect(result.status).toBe(0);
      }
    }
  });

  it('rejects missing frontmatter delimiters but leaves dry runs and formatting alone', async () => {
    for (const content of ['# Instructions\n', '---\nname: example\n']) {
      const dir = await createSkillProject({ 'skills/example/SKILL.md': content });
      const result = runLint(dir);
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain('frontmatter');
      expect(runLint(dir, ['--dry-run']).status).toBe(0);
      expect(runLint(dir, ['--format']).status).toBe(0);
    }
  });
});

async function createSkillProject(files: Record<string, string>): Promise<string> {
  const dir = createTempDir();
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"skill-example","private":true}');
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), content);
  }
  return dir;
}

function runLint(dir: string, args: string[] = []): childProcess.SpawnSyncReturns<string> {
  return childProcess.spawnSync('bun', [cliPath, '--working-dir', dir, 'lint', ...args], { encoding: 'utf8' });
}

function git(cwd: string, ...args: string[]): void {
  childProcess.execFileSync('git', args, { cwd, stdio: 'pipe' });
}
