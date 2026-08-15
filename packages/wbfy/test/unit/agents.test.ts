import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generateAgentInstructions } from '../../src/generators/agents.js';
import type { PackageConfig } from '../../src/packageConfig.js';
import { promisePool } from '../../src/utils/promisePool.js';

import { createConfig } from '../helpers/testConfig.js';

const generatedFileNames = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursor/rules/general.mdc'];

/** Generates the agent instruction files in a throwaway repository and returns their contents. */
async function generateInstructionFiles(
  buildConfigs: (dirPath: string) => [PackageConfig, ...PackageConfig[]]
): Promise<string[]> {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-agents-')));
  try {
    const [rootConfig, ...subConfigs] = buildConfigs(tempDirPath);
    await generateAgentInstructions(rootConfig, [rootConfig, ...subConfigs]);
    await promisePool.promiseAll();

    return generatedFileNames.map((fileName) => fs.readFileSync(path.join(tempDirPath, fileName), 'utf8'));
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
}

const createRootConfig = (dirPath: string, overrides: Partial<PackageConfig> = {}): PackageConfig =>
  createConfig({ dirPath, isRoot: true, packageJson: { name: '@willbooster/example' }, ...overrides });

const createSubConfig = (dirPath: string, name: string, overrides: Partial<PackageConfig> = {}): PackageConfig =>
  createConfig({
    dirPath: path.join(dirPath, 'packages', name),
    packageJson: { name: `@willbooster/${name}` },
    ...overrides,
  });

test('states the macOS/Linux-only rule in every agent instruction file', async () => {
  const contents = await generateInstructionFiles((dirPath) => [createRootConfig(dirPath)]);

  for (const content of contents) {
    expect(content).toContain(
      '- Ensure compatibility only with macOS and Linux; do not include Windows-specific code.'
    );
  }
});

test('scopes the OS compatibility rule when the repository ships a Tauri desktop app', async () => {
  const contents = await generateInstructionFiles((dirPath) => [
    createRootConfig(dirPath, { depending: { ...createConfig().depending, tauri: true } }),
  ]);

  for (const content of contents) {
    expect(content).toContain('the Tauri desktop app additionally supports Windows');
    expect(content).not.toContain('do not include Windows-specific code');
  }
});

test('scopes the OS compatibility rule when a workspace package contains a Tauri config', async () => {
  const contents = await generateInstructionFiles((dirPath) => [
    createRootConfig(dirPath, { doesContainTauriConfigInPackages: true }),
  ]);

  for (const content of contents) {
    expect(content).toContain('the Tauri desktop app additionally supports Windows');
  }
});

test('correlates the server-instance rule with each package deployment target', async () => {
  const vinextDepending = { ...createConfig().depending, vinext: true };

  // A vinext app that IS the Worker gets the multi-isolate rule, not the single-instance one.
  const [workersApp] = await generateInstructionFiles((dirPath) => [
    createRootConfig(dirPath, { depending: vinextDepending, doesContainWranglerConfig: true }),
  ]);
  expect(workersApp).toContain('multiple ephemeral isolates');
  expect(workersApp).not.toContain('Assume a single server instance.');

  // A Worker-only repository (e.g. a Hono API) needs the multi-isolate rule too.
  const [workerOnly] = await generateInstructionFiles((dirPath) => [
    createRootConfig(dirPath, { doesContainWranglerConfig: true }),
  ]);
  expect(workerOnly).toContain('multiple ephemeral isolates');
  expect(workerOnly).not.toContain('Assume a single server instance.');

  // A server-hosted vinext app keeps the single-instance simplification.
  const [serverApp] = await generateInstructionFiles((dirPath) => [
    createRootConfig(dirPath, { depending: vinextDepending }),
  ]);
  expect(serverApp).toContain('Assume a single server instance.');
  expect(serverApp).not.toContain('ephemeral isolates');

  // A monorepo mixing both must not let the unrelated Worker suppress the server app's rule.
  const [mixed] = await generateInstructionFiles((dirPath) => [
    createRootConfig(dirPath, { depending: vinextDepending }),
    createSubConfig(dirPath, 'api', { doesContainWranglerConfig: true }),
  ]);
  expect(mixed).toContain('multiple ephemeral isolates');
  expect(mixed).toContain('assume a single server instance for the other server apps');
});
