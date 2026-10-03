import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expect, setDefaultTimeout, test } from 'bun:test';
import semver from 'semver';
import { z } from 'zod';

import { generatePackageJson } from '../../src/generators/packageJson.js';
import { generateRenovateJsonc } from '../../src/generators/renovateJsonc.js';
import { getPackageConfig } from '../../src/packageConfig.js';

setDefaultTimeout(120_000);

const manifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()).optional(),
});
const renovateSchema = z.object({
  packageRules: z
    .array(
      z.object({
        allowedVersions: z.string().optional(),
        matchFileNames: z.array(z.string()).optional(),
        matchPackageNames: z.array(z.string()),
      })
    )
    .optional(),
});

test('restricts Renovate to Blitz manifests in a mixed workspace repository', async () => {
  await fs.mkdir('.tmp', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.tmp/blitz-workspaces-'));
  try {
    const manifests = {
      'package.json': { name: 'root', private: true, workspaces: ['packages/*'] },
      'packages/blitz-app/package.json': { name: 'blitz-app', dependencies: { blitz: '2.2.4', next: '16.3.6' } },
      'packages/next-app/package.json': { name: 'next-app', dependencies: { next: '16.3.6' } },
    };
    const configs = [];
    for (const [fileName, manifest] of Object.entries(manifests)) {
      const filePath = path.join(root, fileName);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(manifest));
      const config = await getPackageConfig(path.dirname(filePath), { isRoot: fileName === 'package.json' });
      assert.ok(config);
      configs.push(config);
    }
    const rootConfig = configs[0];
    assert.ok(rootConfig);
    for (const config of configs) await generatePackageJson(config, rootConfig, true);
    await generateRenovateJsonc(rootConfig, configs);
    const renovatePath = path.join(root, 'renovate.jsonc');
    const renovate = renovateSchema.parse(await Bun.file(renovatePath).json());
    const rule = renovate.packageRules?.find((entry) => entry.matchPackageNames.includes('next'));
    assert.ok(rule?.allowedVersions);
    for (const config of configs.slice(1)) {
      const manifestPath = path.join(config.dirPath, 'package.json');
      const generated = manifestSchema.parse(await Bun.file(manifestPath).json());
      const version = generated.dependencies.next;
      assert.ok(version);
      const constrained = rule.matchFileNames?.includes(path.relative(root, manifestPath));
      expect(constrained).toBe(config.depending.blitz);
      expect(semver.satisfies(version, rule.allowedVersions)).toBe(config.depending.blitz);
    }
    const firstRenovate = await fs.readFile(renovatePath, 'utf8');
    await generateRenovateJsonc(rootConfig, configs);
    expect(await fs.readFile(renovatePath, 'utf8')).toBe(firstRenovate);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('converges incompatible Blitz manifests on a stable Next.js 15 pin without changing plain Next.js apps', async () => {
  await fs.mkdir('.tmp', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.tmp/blitz-next-'));
  try {
    const manifests = [
      { dependencies: { blitz: '2.2.4', next: '16.3.6' } },
      { dependencies: { blitz: '2.2.4', next: '^15.0.0' } },
      { dependencies: { blitz: '2.2.4' }, devDependencies: { next: '16.3.6' } },
      { dependencies: { blitz: '2.2.4' } },
      { dependencies: { next: '16.3.6' } },
    ];
    for (const [index, manifest] of manifests.entries()) {
      const dirPath = path.join(root, String(index));
      await fs.mkdir(dirPath);
      const packageJsonPath = path.join(dirPath, 'package.json');
      await fs.writeFile(packageJsonPath, JSON.stringify({ name: 'app', private: true, ...manifest }));
      const config = await getPackageConfig(dirPath, { isRoot: true });
      assert.ok(config);
      await generatePackageJson(config, config, true);
      await generateRenovateJsonc(config);
      const generated = manifestSchema.parse(await Bun.file(packageJsonPath).json());
      const nextVersion = generated.dependencies.next;
      assert.ok(nextVersion);
      if (manifest.dependencies.blitz) {
        expect(semver.valid(nextVersion)).toBe(nextVersion);
        expect(semver.major(nextVersion)).toBe(15);
        expect(semver.prerelease(nextVersion)).toBeNull();
        expect(generated.devDependencies?.next).toBeUndefined();
      } else {
        assert.ok(manifest.dependencies.next);
        expect(nextVersion).toBe(manifest.dependencies.next);
      }
      const renovatePath = path.join(dirPath, 'renovate.jsonc');
      const renovate = renovateSchema.parse(await Bun.file(renovatePath).json());
      const rule = renovate.packageRules?.find((entry) => entry.matchPackageNames.includes('next'));
      if (manifest.dependencies.blitz) {
        assert.ok(rule?.allowedVersions);
        expect(semver.satisfies(nextVersion, rule.allowedVersions)).toBe(true);
        expect(semver.satisfies('16.3.6', rule.allowedVersions)).toBe(false);
      } else {
        expect(rule).toBeUndefined();
      }
      const firstRenovate = await fs.readFile(renovatePath, 'utf8');
      await generatePackageJson(config, config, true);
      await generateRenovateJsonc(config);
      const repeated = manifestSchema.parse(await Bun.file(packageJsonPath).json());
      expect(repeated.dependencies.next).toBe(nextVersion);
      expect(repeated.devDependencies?.next).toBeUndefined();
      expect(await fs.readFile(renovatePath, 'utf8')).toBe(firstRenovate);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
