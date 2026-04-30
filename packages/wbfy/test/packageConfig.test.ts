import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { getPackageConfig } from '../src/packageConfig.js';

describe('getPackageConfig', () => {
  test('reads mise task commands from string and array forms', async () => {
    const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wbfy-package-config-'));
    await fs.promises.writeFile(path.join(rootPath, 'package.json'), '{"private":true}\n');
    const dirPath = path.join(rootPath, 'packages', 'mise-package');
    await fs.promises.mkdir(dirPath, { recursive: true });
    await fs.promises.writeFile(
      path.join(dirPath, 'package.json'),
      `${JSON.stringify({ name: 'mise-package', private: true }, undefined, 2)}\n`
    );
    await fs.promises.writeFile(
      path.join(dirPath, 'mise.toml'),
      `
[tasks]
build = "bun run build"
test = ["bun run test:unit", "bun run test:e2e"]

[tasks.typecheck]
run = ["bun run tsc --noEmit", "bun run tsgo --noEmit"]
`
    );

    const config = await getPackageConfig(dirPath);

    expect(config?.miseTasks).toMatchObject({
      build: 'bun run build',
      test: 'bun run test:unit\nbun run test:e2e',
      typecheck: 'bun run tsc --noEmit\nbun run tsgo --noEmit',
    });
  });
});
