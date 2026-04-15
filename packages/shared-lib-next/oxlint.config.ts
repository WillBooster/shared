import fs from 'node:fs';
import { createRequire } from 'node:module';

import { defineConfig } from 'oxlint';
const require = createRequire(import.meta.url);
const sharedConfigPath = require.resolve('@willbooster/oxlint-config');
const sharedConfig = parseJsonc(fs.readFileSync(sharedConfigPath, 'utf8')) as { ignorePatterns?: string[] };

export default defineConfig({
  extends: [sharedConfig],
  ignorePatterns: [...(sharedConfig.ignorePatterns ?? []), 'oxlint.config.ts'],
});

function parseJsonc(text: string): unknown {
  // The shared config only uses full-line // comments, so we avoid pulling in
  // a JSONC parser just to read ignorePatterns.
  const json = text.replaceAll(/^\s*\/\/.*$/gmu, '').replaceAll(/,\s*([}\]])/gu, '$1');
  return JSON.parse(json);
}
