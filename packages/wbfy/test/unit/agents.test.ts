import { expect, test } from 'vitest';

import { generateAgentCodingStyle } from '../../src/generators/agents.js';
import type { PackageConfig } from '../../src/packageConfig.js';

import { createConfig } from '../helpers/testConfig.js';

// The OS restriction survives only outside the general-public-OSS rule, which a `@willbooster/`
// package excludes.
const createScopedConfig = (overrides: Partial<PackageConfig> = {}): PackageConfig =>
  createConfig({ packageJson: { name: '@willbooster/example' }, ...overrides });

test('emits the macOS/Linux-only rule for non-desktop repositories', () => {
  const content = generateAgentCodingStyle(createScopedConfig(), [createScopedConfig()]);

  expect(content).toContain('- Ensure compatibility only with macOS and Linux; do not include Windows-specific code.');
});

test('scopes the OS compatibility rule when the repository ships a Tauri desktop app', () => {
  const config = createScopedConfig();
  config.depending.tauri = true;

  const content = generateAgentCodingStyle(config, [config]);

  expect(content).toContain('the Tauri desktop app additionally supports Windows');
  expect(content).not.toContain('do not include Windows-specific code');
});

test('scopes the OS compatibility rule when a workspace package contains a Tauri config', () => {
  const config = createScopedConfig({ doesContainTauriConfigInPackages: true });
  const content = generateAgentCodingStyle(config, [config]);

  expect(content).toContain('the Tauri desktop app additionally supports Windows');
});

test('omits the OS compatibility rule for public OSS without a `@willbooster/` package', () => {
  const rootConfig = createConfig({ packageJson: { name: 'example' } });
  const subConfig = createConfig({ packageJson: { name: 'sub' } });
  expect(generateAgentCodingStyle(rootConfig, [rootConfig, subConfig])).not.toContain('macOS and Linux');

  // A private repository is not OSS for the general public, so it keeps the restriction.
  const privateConfig = createConfig({ packageJson: { name: 'example' }, isPublicRepo: false });
  expect(generateAgentCodingStyle(privateConfig, [privateConfig])).toContain('only with macOS and Linux');
});

test('correlates the server-instance rule with each package deployment target', () => {
  const vinextDepending = { ...createConfig().depending, vinext: true };

  // A vinext app that IS the Worker gets the multi-isolate rule, not the single-instance one.
  const workersApp = createConfig({ depending: vinextDepending, doesContainWranglerConfig: true });
  const workersStyle = generateAgentCodingStyle(workersApp, [workersApp]);
  expect(workersStyle).toContain('multiple ephemeral isolates');
  expect(workersStyle).not.toContain('Assume a single server instance.');

  // A Worker-only repository (e.g. a Hono API) needs the multi-isolate rule too.
  const workerOnly = createConfig({ doesContainWranglerConfig: true });
  const workerOnlyStyle = generateAgentCodingStyle(workerOnly, [workerOnly]);
  expect(workerOnlyStyle).toContain('multiple ephemeral isolates');
  expect(workerOnlyStyle).not.toContain('Assume a single server instance.');

  // A server-hosted vinext app keeps the single-instance simplification.
  const serverApp = createConfig({ depending: vinextDepending });
  const serverStyle = generateAgentCodingStyle(serverApp, [serverApp]);
  expect(serverStyle).toContain('Assume a single server instance.');
  expect(serverStyle).not.toContain('ephemeral isolates');

  // A monorepo mixing both must not let the unrelated Worker suppress the server app's rule.
  const mixedStyle = generateAgentCodingStyle(serverApp, [serverApp, workerOnly]);
  expect(mixedStyle).toContain('multiple ephemeral isolates');
  expect(mixedStyle).toContain('assume a single server instance for the other server apps');
});
