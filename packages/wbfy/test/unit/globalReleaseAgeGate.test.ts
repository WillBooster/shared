import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { bunMinimumReleaseAgeExcludes, bunMinimumReleaseAgeSeconds } from '../../src/generators/bunfig.js';
import { getWbfyDirPath } from '../../src/utils/version.js';

const scriptPath = path.join(getWbfyDirPath(), 'configs', 'applyReleaseAgeGate.sh');

test('writes the gate into every global config while keeping the other settings', async () => {
  const workDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-release-age-gate-'));
  try {
    const homeDirPath = path.join(workDirPath, 'home');
    const xdgDirPath = path.join(workDirPath, 'xdg');
    await fs.mkdir(homeDirPath);
    // npm and Yarn append settings written after a previous run BELOW the gate, so the settings
    // kept here must not depend on their position.
    await fs.writeFile(
      path.join(homeDirPath, '.npmrc'),
      'registry=https://example.com/\nmin-release-age=1\nmin-release-age-exclude[]=stale\n//example.com/:_authToken=secret\n'
    );
    await fs.writeFile(
      path.join(homeDirPath, '.yarnrc.yml'),
      `npmMinimalAgeGate: 1
npmPreapprovedPackages:
  - stale
npmRegistries:
  //example.com:
    npmAuthToken: secret
`
    );

    const run = (): number | null =>
      childProcess.spawnSync('bash', [scriptPath], {
        env: { ...process.env, HOME: homeDirPath, XDG_CONFIG_HOME: xdgDirPath },
        stdio: 'inherit',
      }).status;
    expect(run()).toBe(0);

    const npmrc = await fs.readFile(path.join(homeDirPath, '.npmrc'), 'utf8');
    expect(npmrc).toContain('registry=https://example.com/\n');
    expect(npmrc).toContain('//example.com/:_authToken=secret\n');
    expect(npmrc).not.toContain('stale');
    expect(npmrc).toContain(`min-release-age=${bunMinimumReleaseAgeSeconds / 86_400}\n`);
    expect(npmrc).toContain('min-release-age-exclude[]=@willbooster/wb\n');

    const yarnrc = await fs.readFile(path.join(homeDirPath, '.yarnrc.yml'), 'utf8');
    expect(yarnrc).toContain('    npmAuthToken: secret\n');
    expect(yarnrc).not.toContain('stale');
    expect(yarnrc).toContain(`npmMinimalAgeGate: ${bunMinimumReleaseAgeSeconds / 60}\n`);
    expect(yarnrc).toContain("  - '@willbooster/wb'\n");

    // bun reads its global configs ONLY from $XDG_CONFIG_HOME once that variable is set, while
    // Yarn always reads $HOME, so no .yarnrc.yml belongs there.
    for (const dirPath of [homeDirPath, xdgDirPath]) {
      const bunfig = await fs.readFile(path.join(dirPath, '.bunfig.toml'), 'utf8');
      expect(bunfig).toContain(`minimumReleaseAge = ${bunMinimumReleaseAgeSeconds}\n`);
      expect(bunfig).toContain(`  "${bunMinimumReleaseAgeExcludes.at(-1)}",\n`);
    }
    expect(await fs.readFile(path.join(xdgDirPath, '.npmrc'), 'utf8')).toBe(npmrc);
    expect(
      await fs.access(path.join(xdgDirPath, '.yarnrc.yml')).then(
        () => true,
        () => false
      )
    ).toBe(false);

    // Re-running must not stack another copy of the gate on top of the previous one.
    expect(run()).toBe(0);
    expect(await fs.readFile(path.join(homeDirPath, '.npmrc'), 'utf8')).toBe(npmrc);
    expect(await fs.readFile(path.join(homeDirPath, '.yarnrc.yml'), 'utf8')).toBe(yarnrc);
  } finally {
    await fs.rm(workDirPath, { force: true, recursive: true });
  }
});
