import fs from 'node:fs';
import path from 'node:path';

import { load as loadYaml } from 'js-yaml';
import { expect, test } from 'vitest';

import { generateWorkflows } from '../../src/generators/workflow.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { createConfig } from '../helpers/testConfig.js';

test('generates a public autofix workflow that can run wb with fnox on CI', async () => {
  const tempRootPath = path.join(process.cwd(), '.tmp');
  await fs.promises.mkdir(tempRootPath, { recursive: true });
  const dirPath = await fs.promises.mkdtemp(path.join(tempRootPath, 'wbfy-autofix-'));
  try {
    await fs.promises.mkdir(path.join(dirPath, '.github', 'workflows'), { recursive: true });
    const config = createConfig({
      dirPath,
      isRoot: true,
      packageJson: { scripts: { build: 'wb build' } },
    });
    await generateWorkflows(config);
    await promisePool.promiseAll();

    const content = await fs.promises.readFile(path.join(dirPath, '.github', 'workflows', 'autofix.yml'), 'utf8');
    const workflow = loadYaml(content) as { jobs: { autofix: { env?: Record<string, string>; steps?: unknown[] } } };
    expect(workflow.jobs.autofix.env).toEqual({ WB_ENV: 'development' });
    expect(workflow.jobs.autofix.steps).toContainEqual({ uses: 'jdx/mise-action@v4.2.0', with: { cache: true } });
  } finally {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  }
});
