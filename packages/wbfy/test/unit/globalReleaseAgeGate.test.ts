import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';

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

    const run = async (): Promise<number | null> => {
      const result = await spawnAsync('bash', [scriptPath], {
        env: { ...process.env, HOME: homeDirPath, XDG_CONFIG_HOME: xdgDirPath },
        stdio: 'inherit',
      });
      return result.status;
    };
    expect(await run()).toBe(0);

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
    expect(await run()).toBe(0);
    expect(await fs.readFile(path.join(homeDirPath, '.npmrc'), 'utf8')).toBe(npmrc);
    expect(await fs.readFile(path.join(homeDirPath, '.yarnrc.yml'), 'utf8')).toBe(yarnrc);
  } finally {
    await fs.rm(workDirPath, { force: true, recursive: true });
  }
});

test('exempts temporarily excluded packages only until their date', async () => {
  const workDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-release-age-gate-'));
  try {
    const homeDirPath = path.join(workDirPath, 'home');
    await fs.mkdir(homeDirPath);
    await fs.copyFile(scriptPath, path.join(workDirPath, 'applyReleaseAgeGate.sh'));
    await fs.writeFile(
      path.join(workDirPath, 'releaseAgeGate.json'),
      JSON.stringify(
        {
          days: 7,
          excludes: ['@willbooster/wb'],
          temporaryExcludes: { '@next/env': '9999-12-31', next: new Date().toISOString().slice(0, 10) },
        },
        undefined,
        2
      )
    );

    const { status } = await spawnAsync('bash', [path.join(workDirPath, 'applyReleaseAgeGate.sh')], {
      env: { ...process.env, HOME: homeDirPath, XDG_CONFIG_HOME: '' },
      stdio: 'inherit',
    });
    expect(status).toBe(0);

    const bunfig = await fs.readFile(path.join(homeDirPath, '.bunfig.toml'), 'utf8');
    expect(bunfig).toContain('minimumReleaseAgeExcludes = [\n  "@willbooster/wb",\n  "@next/env",\n]\n');
  } finally {
    await fs.rm(workDirPath, { force: true, recursive: true });
  }
});

interface CargoConfigCase {
  name: string;
  files: Record<string, string>;
  expected: Record<string, string>;
  exitCode: number;
}

test.each<CargoConfigCase>([
  {
    name: 'adds the gate to a new config.toml',
    files: {},
    expected: { 'config.toml': '[registry]\nglobal-min-publish-age = "7 days"\n' },
    exitCode: 0,
  },
  {
    name: 'keeps the other settings and overwrites a weakened gate',
    files: {
      'config.toml': '[net]\ngit-fetch-with-cli = true\n\n[registry] # crates\nglobal-min-publish-age = "0 days"\n',
    },
    expected: {
      'config.toml': '[net]\ngit-fetch-with-cli = true\n\n[registry] # crates\nglobal-min-publish-age = "7 days"\n',
    },
    exitCode: 0,
  },
  {
    // Cargo reads the legacy file instead of config.toml when both exist.
    name: 'writes the legacy config that Cargo reads',
    files: { config: '[net]\noffline = false\n', 'config.toml': '[net]\noffline = true\n' },
    expected: {
      config: '[net]\noffline = false\n\n[registry]\nglobal-min-publish-age = "7 days"\n',
      'config.toml': '[net]\noffline = true\n',
    },
    exitCode: 0,
  },
  {
    name: 'leaves a config whose gate does not read back untouched and fails',
    files: { 'config.toml': 'registry.default = "crates-io"\n' },
    expected: { 'config.toml': 'registry.default = "crates-io"\n' },
    exitCode: 1,
  },
])('$name in the global Cargo config', async ({ files, expected, exitCode }) => {
  const workDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-release-age-gate-'));
  try {
    const homeDirPath = path.join(workDirPath, 'home');
    const cargoHomeDirPath = path.join(workDirPath, 'cargo');
    await fs.mkdir(homeDirPath);
    await fs.mkdir(cargoHomeDirPath);
    for (const [fileName, content] of Object.entries(files)) {
      await fs.writeFile(path.join(cargoHomeDirPath, fileName), content);
    }

    const spawned = Bun.spawn(['bun', path.join(import.meta.dir, '../../src/index.ts'), 'apply-release-age-gate'], {
      env: { ...Bun.env, CARGO_HOME: cargoHomeDirPath, HOME: homeDirPath, XDG_CONFIG_HOME: '' },
      stderr: 'inherit',
      stdout: 'inherit',
    });
    expect(await spawned.exited).toBe(exitCode);

    const actual: Record<string, string> = {};
    for (const fileName of await fs.readdir(cargoHomeDirPath)) {
      actual[fileName] = await fs.readFile(path.join(cargoHomeDirPath, fileName), 'utf8');
    }
    expect(actual).toEqual(expected);
  } finally {
    await fs.rm(workDirPath, { force: true, recursive: true });
  }
});
