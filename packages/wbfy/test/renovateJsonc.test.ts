import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generateRenovateJsonc } from '../src/generators/renovateJsonc.js';
import { fsUtil } from '../src/utils/fsUtil.js';
import { promisePool } from '../src/utils/promisePool.js';
import { createConfig } from './testConfig.js';

async function withRepo(files: Record<string, string>, run: (dirPath: string) => Promise<void>): Promise<void> {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-renovate-')));
  try {
    for (const [fileName, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tempDirPath, fileName)), { recursive: true });
      fs.writeFileSync(path.join(tempDirPath, fileName), content);
    }
    fsUtil.setRootDirPath(tempDirPath);
    await generateRenovateJsonc(createConfig({ dirPath: tempDirPath, isRoot: true }));
    await promisePool.promiseAll();
    await run(tempDirPath);
  } finally {
    fsUtil.setRootDirPath(undefined);
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
}

const preset = 'github>WillBooster/willbooster-configs:renovate.json5';

test('generates renovate.jsonc in a repository without any Renovate config', async () => {
  await withRepo({}, async (dirPath) => {
    const content = fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8');
    expect(JSON.parse(content).extends).toEqual([preset]);
  });
});

test('migrates renovate.json and deletes it so it stops outranking renovate.jsonc', async () => {
  await withRepo(
    { 'renovate.json': JSON.stringify({ extends: [preset], labels: ['dependencies'] }) },
    async (dirPath) => {
      const content = fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8');
      expect(JSON.parse(content).labels).toEqual(['dependencies']);
      expect(fs.existsSync(path.join(dirPath, 'renovate.json'))).toBe(false);
    }
  );
});

test('migrates renovate.json5, whose unquoted keys and single quotes plain JSONC cannot parse', async () => {
  await withRepo(
    {
      'renovate.json5': `{
  $schema: 'https://docs.renovatebot.com/renovate-schema.json',
  extends: ['${preset}'],
  // Scope mapping only (no credentials).
  npmrc: '@willbooster-private:registry=https://example.test/',
}
`,
    },
    async (dirPath) => {
      const settings = JSON.parse(fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8'));
      expect(settings.npmrc).toBe('@willbooster-private:registry=https://example.test/');
      expect(settings.extends).toEqual([preset]);
      expect(fs.existsSync(path.join(dirPath, 'renovate.json5'))).toBe(false);
    }
  );
});

test('keeps comments in renovate.jsonc while adding a generated property', async () => {
  await withRepo(
    {
      'renovate.jsonc': `{
  // Keep the private registry mapping close to the preset it complements.
  "npmrc": "@willbooster-private:registry=https://example.test/"
}
`,
    },
    async (dirPath) => {
      const content = fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8');
      expect(content).toContain('// Keep the private registry mapping close to the preset it complements.');
      expect(JSON.parse(stripComments(content)).extends).toEqual([preset]);
    }
  );
});

test('lets the config Renovate actually reads win over a dead lower-priority one', async () => {
  // renovate.json outranks renovate.json5, so its value is the live setting to carry over.
  await withRepo(
    {
      'renovate.json': JSON.stringify({ timezone: 'Asia/Tokyo' }),
      'renovate.json5': "{ timezone: 'UTC' }",
    },
    async (dirPath) => {
      const settings = JSON.parse(fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8'));
      expect(settings.timezone).toBe('Asia/Tokyo');
      expect(fs.existsSync(path.join(dirPath, 'renovate.json5'))).toBe(false);
    }
  );
});

test('bails instead of shadowing a config Renovate resolves after renovate.jsonc', async () => {
  await withRepo({ '.github/renovate.json': JSON.stringify({ extends: [preset] }) }, async (dirPath) => {
    expect(fs.existsSync(path.join(dirPath, 'renovate.jsonc'))).toBe(false);
  });
});

test('leaves an unparsable renovate.jsonc untouched', async () => {
  const brokenContent = '{ "extends": [ }';
  await withRepo({ 'renovate.jsonc': brokenContent }, async (dirPath) => {
    expect(fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8')).toBe(brokenContent);
  });
});

function stripComments(content: string): string {
  return content.replaceAll(/^\s*\/\/.*$/gmu, '');
}
