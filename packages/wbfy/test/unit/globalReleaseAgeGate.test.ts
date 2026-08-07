import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { bunMinimumReleaseAgeExcludes, bunMinimumReleaseAgeSeconds } from '../../src/generators/bunfig.js';
import { getWbfyDirPath } from '../../src/utils/version.js';

const scriptPath = path.join(getWbfyDirPath(), 'configs', 'applyReleaseAgeGate.sh');

test('writes the gate into every global config while keeping the registry settings above it', async () => {
  const workDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-release-age-gate-'));
  try {
    const homeDirPath = path.join(workDirPath, 'home');
    const xdgDirPath = path.join(workDirPath, 'xdg');
    // A failing sudo keeps the test from touching root's real configs on a machine that grants
    // passwordless sudo (every self-hosted runner does).
    const binDirPath = path.join(workDirPath, 'bin');
    await fs.mkdir(homeDirPath);
    await fs.mkdir(binDirPath);
    await fs.writeFile(path.join(binDirPath, 'sudo'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await fs.writeFile(path.join(homeDirPath, '.npmrc'), 'registry=https://example.com/\nmin-release-age=1\n');

    const run = (): number | null =>
      childProcess.spawnSync('bash', [scriptPath], {
        env: {
          ...process.env,
          HOME: homeDirPath,
          PATH: `${binDirPath}:${process.env['PATH'] ?? ''}`,
          XDG_CONFIG_HOME: xdgDirPath,
        },
        stdio: 'inherit',
      }).status;
    expect(run()).toBe(0);

    const npmrc = await fs.readFile(path.join(homeDirPath, '.npmrc'), 'utf8');
    expect(npmrc).toContain('registry=https://example.com/');
    expect(npmrc).toContain(`min-release-age=${bunMinimumReleaseAgeSeconds / 86_400}\n`);
    expect(npmrc).not.toContain('min-release-age=1\n');
    expect(npmrc).toContain('min-release-age-exclude[]=@willbooster/wb\n');

    const yarnrc = await fs.readFile(path.join(homeDirPath, '.yarnrc.yml'), 'utf8');
    expect(yarnrc).toContain(`npmMinimalAgeGate: ${bunMinimumReleaseAgeSeconds / 60}\n`);
    expect(yarnrc).toContain("  - '@willbooster/wb'\n");

    // bun reads its global bunfig ONLY from $XDG_CONFIG_HOME once that variable is set.
    for (const dirPath of [homeDirPath, xdgDirPath]) {
      const bunfig = await fs.readFile(path.join(dirPath, '.bunfig.toml'), 'utf8');
      expect(bunfig).toContain(`minimumReleaseAge = ${bunMinimumReleaseAgeSeconds}\n`);
      expect(bunfig).toContain(`  "${bunMinimumReleaseAgeExcludes.at(-1)}",\n`);
    }

    // Re-running must not stack another copy of the gate on top of the previous one.
    expect(run()).toBe(0);
    expect(await fs.readFile(path.join(homeDirPath, '.npmrc'), 'utf8')).toBe(npmrc);
    expect(await fs.readFile(path.join(homeDirPath, '.yarnrc.yml'), 'utf8')).toBe(yarnrc);
  } finally {
    await fs.rm(workDirPath, { force: true, recursive: true });
  }
});
