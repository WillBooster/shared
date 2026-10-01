import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { generateAgentInstructions } from '../../src/generators/agents.js';
import { generatePackageJson } from '../../src/generators/packageJson.js';
import { getPackageConfig } from '../../src/packageConfig.js';
import { fsUtil } from '../../src/utils/fsUtil.js';

test('keeps a bare playwright that only provides the Vitest browser', async () => {
  const tempRootPath = path.join(process.cwd(), '.tmp');
  await fs.promises.mkdir(tempRootPath, { recursive: true });
  const dirPath = await fs.promises.mkdtemp(path.join(tempRootPath, 'wbfy-playwright-detection-'));
  try {
    // The packages/<name> layout keeps getPackageConfig from looking up a GitHub repository.
    fs.writeFileSync(path.join(dirPath, 'package.json'), '{}');
    const packageDirPath = path.join(dirPath, 'packages', 'grammar');
    fs.mkdirSync(packageDirPath, { recursive: true });
    const devDependencies = { '@vitest/browser-playwright': '4.1.10', playwright: '1.63.0', vitest: '4.1.10' };
    fs.writeFileSync(path.join(packageDirPath, 'package.json'), JSON.stringify({ name: 'grammar', devDependencies }));
    fs.writeFileSync(
      path.join(packageDirPath, 'vitest.config.mts'),
      "import { playwright } from '@vitest/browser-playwright';\n"
    );
    fsUtil.setRootDirPath(packageDirPath);

    const packageConfig = await getPackageConfig(packageDirPath);
    if (!packageConfig) throw new Error('getPackageConfig rejected the package.');
    const config = { ...packageConfig, isRoot: true };
    await generatePackageJson(config, config, true);
    await generateAgentInstructions(config, [config]);

    const packageJson = JSON.parse(fs.readFileSync(path.join(packageDirPath, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    expect(packageJson.devDependencies).toMatchObject(devDependencies);
    expect(fs.readFileSync(path.join(packageDirPath, 'AGENTS.md'), 'utf8')).not.toContain('wb start --mode test');
  } finally {
    fsUtil.setRootDirPath(undefined);
    await fs.promises.rm(dirPath, { force: true, recursive: true });
  }
}, 60_000);
