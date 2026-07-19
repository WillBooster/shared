import { expect, test } from 'vitest';

import { generateAgentCodingStyle } from '../src/generators/agents.js';

import { createConfig } from './testConfig.js';

test('emits the macOS/Linux-only rule for non-desktop repositories', () => {
  const content = generateAgentCodingStyle([createConfig()]);

  expect(content).toContain('- Ensure compatibility only with macOS and Linux; do not include Windows-specific code.');
});

test('scopes the OS compatibility rule when the repository ships a Tauri desktop app', () => {
  const config = createConfig();
  config.depending.tauri = true;

  const content = generateAgentCodingStyle([config]);

  expect(content).toContain('the Tauri desktop app additionally supports Windows');
  expect(content).not.toContain('do not include Windows-specific code');
});

test('scopes the OS compatibility rule when a workspace package contains a Tauri config', () => {
  const content = generateAgentCodingStyle([createConfig({ doesContainTauriConfigInPackages: true })]);

  expect(content).toContain('the Tauri desktop app additionally supports Windows');
});
