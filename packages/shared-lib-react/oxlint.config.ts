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
  return JSON.parse(stripJsonComments(text).replaceAll(/,\s*([}\]])/gu, '$1'));
}

function stripJsonComments(text: string): string {
  let result = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      if (char === '\n' || char === '\r') {
        inLineComment = false;
        result += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index++;
      }
      continue;
    }
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      index++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      index++;
      continue;
    }
    result += char;
  }

  return result;
}
