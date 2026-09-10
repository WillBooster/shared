import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, expect, it } from 'vitest';

const cliPath = path.resolve('bin/index.js');

beforeAll(() => {
  const build = spawnSync('bun', ['run', 'build'], { encoding: 'utf8', timeout: 30_000 });
  expect(build.status, build.stdout + build.stderr).toBe(0);
});

it.each([0, 1, 2])('checks only selected decks with -- after %i paths', async (separatorIndex) => {
  const tmp = path.resolve('.tmp');
  await fs.mkdir(tmp, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tmp, 'slidev-check-'));
  try {
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'slidev-check-fixture' }));
    const selected = ['intro.slidev.md', "author's slides.slidev.md"];
    for (const file of [...selected, 'unselected.slidev.md']) {
      await fs.writeFile(path.join(dir, file), '# Slide\n');
    }
    const args = [...selected];
    args.splice(separatorIndex, 0, '--');
    const result = spawnSync('node', [cliPath, 'slidev-check', '--dry-run', '--fix', ...args], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.match(/Command:/g)).toHaveLength(selected.length);
    expect(result.stdout).toContain('intro.slidev.md');
    expect(result.stdout).toContain('slides.slidev.md');
    expect(result.stdout).not.toContain('unselected.slidev.md');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
