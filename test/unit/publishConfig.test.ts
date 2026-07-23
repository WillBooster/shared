import { describe, expect, test } from 'bun:test';

const releasedPackages = ['shared-lib-node', 'wb', 'wbfy'];

describe('npm publishing', () => {
  test.each(releasedPackages)('%s publishes directly to npmjs', async (packageName) => {
    const packageJson = await Bun.file(`packages/${packageName}/package.json`).json();

    expect(packageJson.publishConfig.registry).toBe('https://registry.npmjs.org/');
  });
});
