import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { fixRailwayignore } from '../../src/generators/railwayignore.js';

import { createConfig } from '../helpers/testConfig.js';

test('unignores .docker.env only when the Dockerfile consumes it', async () => {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-railwayignore-'));
  const filePath = path.join(dirPath, '.railwayignore');
  try {
    await fixRailwayignore(
      createConfig({ dirPath, isRailway: true, doesContainDockerfile: true, dockerfile: 'COPY .docker.env ./\n' })
    );
    expect(fs.readFileSync(filePath, 'utf8')).toBe('!.docker.env\n');

    await fixRailwayignore(createConfig({ dirPath, isRailway: true, doesContainDockerfile: true, dockerfile: '' }));
    expect(fs.readFileSync(filePath, 'utf8')).toBe('!.docker.env\n');

    await fixRailwayignore(
      createConfig({
        dirPath,
        isRailway: true,
        doesContainDockerfile: true,
        dockerfile: 'CMD ["./bash/apply-docker-env.sh", "node", "index.js"]\n',
      })
    );
    expect(fs.readFileSync(filePath, 'utf8')).toBe('!.docker.env\n');

    await fixRailwayignore(
      createConfig({ dirPath, isRailway: true, doesContainDockerfile: true, dockerfile: 'COPY package.json ./\n' })
    );
    expect(fs.existsSync(filePath)).toBe(false);
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
});
