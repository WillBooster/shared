import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateRenovateJsonc } from '../../src/generators/renovateJsonc.js';
import { createConfig } from '../helpers/testConfig.js';

const sharedPreset = 'github>WillBooster/willbooster-configs:renovate.jsonc';
const basePreset = 'github>WillBooster/willbooster-configs:renovate-base.jsonc';

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

test('keeps the comments of the remaining package rules when removing obsolete managed rules', async () => {
  await withRepository(
    {
      'renovate.jsonc': `{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["${sharedPreset}"],
  "packageRules": [
    {
      // Keep the first pin.
      "matchPackageNames": ["first"],
      "allowedVersions": "<2",
    },
    {
      "description": "Keep oxc-transform-react within the peer range of the installed @vitejs/plugin-react",
      "matchPackageNames": ["oxc-transform-react"],
      "allowedVersions": "^0.152.0",
    },
    {
      // Keep the last pin.
      "matchPackageNames": ["last"],
      "allowedVersions": "<3",
    },
    {
      "description": "@vitejs/plugin-react peer-requires a single minor of oxc-transform-react, which Renovate does not check, so update both together and review them by hand",
      "matchPackageNames": ["@vitejs/plugin-react", "oxc-transform-react"],
    },
  ],
}
`,
    },
    async (dirPath) => {
      await generateRenovateJsonc(createConfig({ dirPath }));

      const content = fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8');
      expect(content).toContain('// Keep the first pin.');
      expect(content).toContain('// Keep the last pin.');
      expect(content).not.toContain('oxc-transform-react');
      expect(Bun.JSONC.parse(content)).toEqual({
        $schema: 'https://docs.renovatebot.com/renovate-schema.json',
        extends: [sharedPreset],
        packageRules: [
          { matchPackageNames: ['first'], allowedVersions: '<2' },
          { matchPackageNames: ['last'], allowedVersions: '<3' },
        ],
      });
    }
  );
});

test('removes an obsolete managed rule followed by a comment before its comma', async () => {
  await withRepository(
    {
      'renovate.jsonc': `{"$schema":"https://docs.renovatebot.com/renovate-schema.json","extends":["${sharedPreset}"],"packageRules":[{"description":"Keep oxc-transform-react within the peer range of the installed @vitejs/plugin-react"} /* obsolete */,{"matchPackageNames":["kept"]}]}`,
    },
    async (dirPath) => {
      await generateRenovateJsonc(createConfig({ dirPath }));

      const content = fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8');
      expect(Bun.JSONC.parse(content)).toEqual({
        $schema: 'https://docs.renovatebot.com/renovate-schema.json',
        extends: [sharedPreset],
        packageRules: [{ matchPackageNames: ['kept'] }],
      });
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

test.each([
  ['without a Renovate config', {}],
  ['extending renovate-base.jsonc', { 'renovate.jsonc': JSON.stringify({ extends: [basePreset] }) }],
])('extends renovate-base.jsonc alone in a repository outside the WillBooster organizations %s', async (_, files) => {
  await withRepository(files, async (dirPath) => {
    await generateRenovateJsonc(
      createConfig({ dirPath, repository: 'github:someone/example', isWillBoosterRepo: false })
    );

    const settings = JSON.parse(fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8')) as {
      $schema?: string;
      extends: string[];
    };
    expect(settings).toEqual({ $schema: 'https://docs.renovatebot.com/renovate-schema.json', extends: [basePreset] });
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
