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
