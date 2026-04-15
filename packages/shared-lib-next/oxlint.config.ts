import { defineConfig } from 'oxlint';

declare const process: {
  getBuiltinModule(name: 'fs'): {
    readFileSync(path: string, encoding: 'utf8'): string;
  };
  getBuiltinModule(name: 'module'): {
    createRequire(url: string): {
      resolve(specifier: string): string;
    };
  };
};

const fs = process.getBuiltinModule('fs');
const { createRequire } = process.getBuiltinModule('module');
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
