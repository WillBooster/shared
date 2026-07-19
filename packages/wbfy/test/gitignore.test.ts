import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generateGitignore } from '../src/generators/gitignore.js';
import { promisePool } from '../src/utils/promisePool.js';
import { createConfig } from './testConfig.js';

test('keeps maven and python ignore entries in multi-language repositories', async () => {
  // Mirrors a monorepo whose Maven modules and Python lockfiles live in subdirectories only
  // (no root pom.xml / poetry.lock / uv.lock), like WillBoosterLab/judge.
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-gitignore-')));
  try {
    const config = createConfig({
      dirPath: tempDirPath,
      isRoot: true,
      doesContainPomXmlAnywhere: true,
      doesContainPythonLockAnywhere: true,
    });
    await generateGitignore(config, config);
    await promisePool.promiseAll();
    const content = fs.readFileSync(path.join(tempDirPath, '.gitignore'), 'utf8');
    expect(content).toMatch(/^target\/$/mu);
    expect(content).toMatch(/^__pycache__\/$/mu);
    expect(content).toMatch(/^\.venv\/$/mu);
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});
