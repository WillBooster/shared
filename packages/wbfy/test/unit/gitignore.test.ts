import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { generateGitignore } from '../../src/generators/gitignore.js';
import { createConfig } from '../helpers/testConfig.js';

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
    const content = fs.readFileSync(path.join(tempDirPath, '.gitignore'), 'utf8');
    expect(content).toMatch(/^target\/$/mu);
    expect(content).toMatch(/^__pycache__\/$/mu);
    expect(content).toMatch(/^\.venv\/$/mu);
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});

test('ignores node_modules when the root manifest will be created during this run', async () => {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-gitignore-')));
  try {
    const config = createConfig({
      dirPath: tempDirPath,
      isRoot: true,
      doesContainPackageJson: false,
      packageJson: {},
    });
    await generateGitignore(config, config);

    const content = fs.readFileSync(path.join(tempDirPath, '.gitignore'), 'utf8');
    expect(content).toMatch(/^node_modules\/$/mu);
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});

test('keeps negations with trailing comments in vendored templates effective', async () => {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-gitignore-')));
  try {
    const config = createConfig({ dirPath: tempDirPath, isRoot: true });
    await generateGitignore(config, config);
    execFileSync('git', ['init', '--quiet'], { cwd: tempDirPath });

    // The vim template ignores `[._]*.s[a-v][a-z]` and re-includes `!*.svg` with a trailing comment.
    const result = spawnSync('git', ['check-ignore', '_icon.svg'], { cwd: tempDirPath });
    expect(result.status).toBe(1);
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});
