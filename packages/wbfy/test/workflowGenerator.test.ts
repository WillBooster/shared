import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { generateWorkflows } from '../src/generators/workflow.js';
import type { PackageConfig } from '../src/packageConfig.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dirPath) => fs.promises.rm(dirPath, { force: true, recursive: true })));
  tempDirs.length = 0;
});

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-workflow-'));
  tempDirs.push(tempDir);
  return tempDir;
}

test('skips generating workflows for reusable-workflows repository', async () => {
  const dirPath = createTempDir();
  const workflowsPath = path.join(dirPath, '.github', 'workflows');
  await fs.promises.mkdir(workflowsPath, { recursive: true });

  const workflowPath = path.join(workflowsPath, 'existing.yml');
  const workflowContent = 'name: Existing';
  await fs.promises.writeFile(workflowPath, workflowContent);

  const semanticYamlPath = path.join(dirPath, '.github', 'semantic.yml');
  await fs.promises.writeFile(semanticYamlPath, 'semantic');

  const config: PackageConfig = {
    dirPath,
    dockerfile: '',
    isRoot: true,
    isPublicRepo: true,
    isReferredByOtherRepo: false,
    repository: 'github:WillBooster/reusable-workflows',
    isWillBoosterRepo: true,
    isBun: false,
    isEsmPackage: false,
    isWillBoosterConfigs: false,
    doesContainSubPackageJsons: false,
    doesContainDockerfile: false,
    doesContainGemfile: false,
    doesContainGoMod: false,
    doesContainPackageJson: false,
    doesContainPoetryLock: false,
    doesContainPomXml: false,
    doesContainPubspecYaml: false,
    doesContainTemplateYaml: false,
    doesContainVscodeSettingsJson: false,
    doesContainJavaScript: false,
    doesContainTypeScript: false,
    doesContainJsxOrTsx: false,
    doesContainJavaScriptInPackages: false,
    doesContainTypeScriptInPackages: false,
    doesContainJsxOrTsxInPackages: false,
    hasStartTestServer: false,
    depending: {
      blitz: false,
      firebase: false,
      genI18nTs: false,
      litestream: false,
      next: false,
      playwrightTest: false,
      prisma: false,
      pyright: false,
      react: false,
      reactNative: false,
      semanticRelease: false,
      storybook: false,
      wb: false,
    },
    release: {
      branches: [],
      github: false,
      npm: false,
    },
    hasVersionSettings: false,
    packageJson: {},
    wbfyJson: undefined,
  };

  await generateWorkflows(config);

  expect(await fs.promises.readFile(workflowPath, 'utf8')).toBe(workflowContent);
  expect(await fs.promises.readdir(workflowsPath)).toEqual(['existing.yml']);
  expect(fs.existsSync(semanticYamlPath)).toBe(true);
});
