import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generateLefthookUpdatingPackageJson } from '../src/generators/lefthook.js';

import { createConfig } from './testConfig.js';

test('post-merge cache clearing covers workspace frameworks with workspace-relative paths', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-lefthook-'));
  try {
    const rootConfig = createConfig({ dirPath: tempDirPath, isRoot: true });
    const nextConfig = createConfig({
      dirPath: path.join(tempDirPath, 'apps', 'site'),
      depending: { ...createConfig().depending, next: true },
    });
    const vinextConfig = createConfig({
      dirPath: path.join(tempDirPath, 'packages', 'web'),
      depending: { ...createConfig().depending, vinext: true },
    });
    await generateLefthookUpdatingPackageJson(rootConfig, [rootConfig, nextConfig, vinextConfig]);

    const prepareScript = fs.readFileSync(path.join(tempDirPath, '.lefthook', 'post-merge', 'prepare.sh'), 'utf8');
    expect(prepareScript).toContain("bun install && rm -Rf -- 'apps/site/.next'");
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
    await generateLefthookUpdatingPackageJson(otherConfig);
    expect(fs.readFileSync(path.join(tempDirPath, 'lefthook.yml'), 'utf8')).not.toContain('renovate-config-validator');

    const configsConfig = createConfig({ dirPath: tempDirPath, isRoot: true, isWillBoosterConfigs: true });
    await generateLefthookUpdatingPackageJson(configsConfig);
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
    await generateLefthookUpdatingPackageJson(rootConfig, [rootConfig]);

    const prepareScript = fs.readFileSync(path.join(tempDirPath, '.lefthook', 'post-merge', 'prepare.sh'), 'utf8');
    expect(prepareScript).toContain("bun install && rm -Rf -- '.next'");
    expect(prepareScript).not.toContain('node_modules/.vite');
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});
