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
  packageRules: z.array(z.object({ allowedVersions: z.string().optional() })).optional(),
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
      const rule = renovate.packageRules?.find((entry) => entry.allowedVersions);
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
