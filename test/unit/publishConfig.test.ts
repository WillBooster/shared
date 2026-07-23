import { readdir } from 'node:fs/promises';

import { describe, expect, test } from 'bun:test';

const packageDirectories = await readdir('packages');
const packageVisibilities = await Promise.all(
  packageDirectories.map(async (name) => {
    const packageJson = await Bun.file(`packages/${name}/package.json`).json();
    return packageJson.private ? [] : [name];
  })
);
const releasedPackages = packageVisibilities.flat();

describe('npm publishing', () => {
  // Without an explicit registry, npm resolves the publish target from the workspace .npmrc,
  // whose default registry on CI may be the Takumi Guard install proxy — which rejects
  // `npm publish` with 405 (run 30050778519).
  test.each(releasedPackages)('%s publishes directly to npmjs', async (packageName) => {
    const packageJson = await Bun.file(`packages/${packageName}/package.json`).json();

    expect(packageJson.publishConfig.registry).toBe('https://registry.npmjs.org/');
  });
});
