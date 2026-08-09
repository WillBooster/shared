import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { fixRailwayignore } from '../../src/generators/railwayignore.js';
import { promisePool } from '../../src/utils/promisePool.js';

import { createConfig } from '../helpers/testConfig.js';

test('unignores .docker.env only when the Dockerfile consumes it', async () => {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-railwayignore-'));
  const filePath = path.join(dirPath, '.railwayignore');
  try {
    await fixRailwayignore(
      createConfig({ dirPath, isRailway: true, doesContainDockerfile: true, dockerfile: 'COPY .docker.env ./\n' })
    );
    await promisePool.promiseAll();
    expect(fs.readFileSync(filePath, 'utf8')).toBe('!.docker.env\n');

    await fixRailwayignore(
      createConfig({ dirPath, isRailway: true, doesContainDockerfile: true, dockerfile: 'COPY package.json ./\n' })
    );
    await promisePool.promiseAll();
    expect(fs.existsSync(filePath)).toBe(false);
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
});
