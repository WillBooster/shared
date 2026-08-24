import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { generateLefthook } from '../../src/generators/lefthook.js';

import { createConfig } from '../helpers/testConfig.js';

test('generated lockfile normalizer removes only Guard registry resolutions', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-lefthook-'));
  try {
    const config = createConfig({ dirPath: tempDirPath, isRoot: true });
    await generateLefthook(config);
    const lockfilePath = path.join(tempDirPath, 'bun.lock');
    fs.writeFileSync(
      lockfilePath,
      `{
  "workspaces": {
    "": {
      "dependencies": {
        "tarball": "https://npm.flatt.tech/direct.tgz"
      }
    }
  },
  "packages": {
    "public": ["public@1.0.0", "https://npm.flatt.tech/public/-/public-1.0.0.tgz", {}],
    "private": ["private@1.0.0", "https://verdaccio.example/private/-/private-1.0.0.tgz", {}],
    "tarball": ["tarball@https://npm.flatt.tech/direct.tgz", {}, "sha512-a"]
  }
}
`
    );

    const result = childProcess.spawnSync('bash', ['.lefthook/normalize-bun-lockfile.sh'], {
      cwd: tempDirPath,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(lockfilePath, 'utf8')).toBe(`{
  "workspaces": {
    "": {
      "dependencies": {
        "tarball": "https://npm.flatt.tech/direct.tgz"
      }
    }
  },
  "packages": {
    "public": ["public@1.0.0", "", {}],
    "private": ["private@1.0.0", "https://verdaccio.example/private/-/private-1.0.0.tgz", {}],
    "tarball": ["tarball@https://npm.flatt.tech/direct.tgz", {}, "sha512-a"]
  }
}
`);
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('post-merge cache clearing covers workspace frameworks with workspace-relative paths', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-lefthook-'));
  try {
    const rootConfig = createConfig({ dirPath: tempDirPath, isRoot: true });
    const nextConfig = createConfig({
      dirPath: path.join(tempDirPath, 'apps', '$site'),
      depending: { ...createConfig().depending, next: true },
    });
    const vinextConfig = createConfig({
      dirPath: path.join(tempDirPath, 'packages', 'web'),
      depending: { ...createConfig().depending, vinext: true },
    });
    await generateLefthook(rootConfig, [rootConfig, nextConfig, vinextConfig]);

    const prepareScript = fs.readFileSync(path.join(tempDirPath, '.lefthook', 'post-merge', 'prepare.sh'), 'utf8');
    expect(prepareScript).toContain(String.raw`bun install && rm -Rf -- 'apps/\$site/.next'`);
    expect(prepareScript).toContain(
      String.raw`if git diff --no-color -U0 ORIG_HEAD HEAD -- '*bunfig.toml' | grep --quiet -E '^[+-] *(globalStore|linker|publicHoistPattern)'; then rm -Rf -- 'apps/$site/node_modules' 'node_modules' 'packages/web/node_modules'; fi`
    );
    expect(prepareScript).toContain(
      String.raw`run_if_changed "(bunfig\.toml|\.npmrc)" "rm -Rf -- 'packages/web/node_modules/.vite'"`
    );
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('the Renovate config validation job is generated only for willbooster-configs', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-lefthook-'));
  try {
    const otherConfig = createConfig({ dirPath: tempDirPath, isRoot: true });
    await generateLefthook(otherConfig);
    expect(fs.readFileSync(path.join(tempDirPath, 'lefthook.yml'), 'utf8')).not.toContain('renovate-config-validator');

    const configsConfig = createConfig({ dirPath: tempDirPath, isRoot: true, isWillBoosterConfigs: true });
    await generateLefthook(configsConfig);
    expect(fs.readFileSync(path.join(tempDirPath, 'lefthook.yml'), 'utf8')).toContain(
      'renovate-config-validator --strict --no-global {staged_files}'
    );
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('post-merge cache clearing stays root-relative for a root-level Next.js app without a Vite cache hook', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-lefthook-'));
  try {
    const rootConfig = createConfig({
      dirPath: tempDirPath,
      isRoot: true,
      depending: { ...createConfig().depending, next: true },
    });
    await generateLefthook(rootConfig, [rootConfig]);

    const prepareScript = fs.readFileSync(path.join(tempDirPath, '.lefthook', 'post-merge', 'prepare.sh'), 'utf8');
    expect(prepareScript).toContain("bun install && rm -Rf -- '.next'");
    expect(prepareScript).not.toContain('node_modules/.vite');
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});
