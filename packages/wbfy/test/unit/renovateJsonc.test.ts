import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { generateRenovateJsonc } from '../../src/generators/renovateJsonc.js';
import { createConfig } from '../helpers/testConfig.js';

const sharedPreset = 'github>WillBooster/willbooster-configs:renovate.jsonc';

test('updates the canonical config without rewriting its unrelated content', async () => {
  await withRepository(
    {
      'renovate.jsonc': `{
  // Keep this repository setting.
  "labels": ["dependencies"]
}
`,
    },
    async (dirPath) => {
      await generateRenovateJsonc(createConfig({ dirPath }));

      const content = fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8');
      expect(content).toContain('// Keep this repository setting.');
      expect(content).toContain('"labels": ["dependencies"]');
      expect(content).toContain(sharedPreset);
    }
  );
});

test('does not shadow a non-canonical Renovate config', async () => {
  const oldContent = '{ "labels": ["dependencies"] }\n';
  await withRepository({ 'renovate.json': oldContent }, async (dirPath) => {
    await generateRenovateJsonc(createConfig({ dirPath }));

    expect(fs.existsSync(path.join(dirPath, 'renovate.jsonc'))).toBe(false);
    expect(fs.readFileSync(path.join(dirPath, 'renovate.json'), 'utf8')).toBe(oldContent);
  });
});

test('does not shadow a dangling symlink at a non-canonical Renovate location', async () => {
  await withRepository({}, async (dirPath) => {
    fs.symlinkSync('missing-renovate.json', path.join(dirPath, 'renovate.json'));

    await generateRenovateJsonc(createConfig({ dirPath }));

    expect(fs.existsSync(path.join(dirPath, 'renovate.jsonc'))).toBe(false);
    expect(fs.lstatSync(path.join(dirPath, 'renovate.json')).isSymbolicLink()).toBe(true);
  });
});

test('leaves an unparsable canonical config untouched', async () => {
  const oldContent = '{ invalid';
  await withRepository({ 'renovate.jsonc': oldContent }, async (dirPath) => {
    await generateRenovateJsonc(createConfig({ dirPath }));

    expect(fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8')).toBe(oldContent);
  });
});

async function withRepository(files: Record<string, string>, run: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-renovate-')));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = path.join(dirPath, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
    await run(dirPath);
  } finally {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}
