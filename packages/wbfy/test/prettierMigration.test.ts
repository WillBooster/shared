import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generateBunfigToml } from '../src/generators/bunfig.js';
import { generateIdeaSettings } from '../src/generators/idea.js';
import { fixVscodeExtensions, generateVscodeSettings } from '../src/generators/vscodeSettings.js';
import { promisePool } from '../src/utils/promisePool.js';

import { createConfig } from './testConfig.js';

test('rewrites prettier-vscode formatter values (including per-language overrides) to the oxc extension', async () => {
  await withTempDir(async (tempDirPath) => {
    const settingsPath = path.join(tempDirPath, '.vscode', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        'editor.defaultFormatter': 'esbenp.prettier-vscode',
        '[typescript]': { 'editor.defaultFormatter': 'esbenp.prettier-vscode' },
      })
    );
    await generateVscodeSettings(createConfig({ dirPath: tempDirPath }));
    await promisePool.promiseAll();
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    expect(settings['editor.defaultFormatter']).toBe('oxc.oxc-vscode');
    expect(settings['[typescript]']).toEqual({ 'editor.defaultFormatter': 'oxc.oxc-vscode' });
  });
});

test('keeps prettier-vscode formatter values in Java repositories', async () => {
  await withTempDir(async (tempDirPath) => {
    const settingsPath = path.join(tempDirPath, '.vscode', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ 'editor.defaultFormatter': 'esbenp.prettier-vscode' }));
    await generateVscodeSettings(createConfig({ dirPath: tempDirPath, doesContainJava: true }));
    await promisePool.promiseAll();
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    expect(settings['editor.defaultFormatter']).toBe('esbenp.prettier-vscode');
  });
});

test('replaces a prettier-vscode recommendation with the oxc extension and dedupes', async () => {
  await withTempDir(async (tempDirPath) => {
    const extensionsPath = path.join(tempDirPath, '.vscode', 'extensions.json');
    fs.mkdirSync(path.dirname(extensionsPath), { recursive: true });
    fs.writeFileSync(
      extensionsPath,
      JSON.stringify({ recommendations: ['esbenp.prettier-vscode', 'oxc.oxc-vscode', 'dbaeumer.vscode-eslint'] })
    );
    await fixVscodeExtensions(createConfig({ dirPath: tempDirPath }));
    await promisePool.promiseAll();
    const extensions = JSON.parse(fs.readFileSync(extensionsPath, 'utf8')) as { recommendations: string[] };
    expect(extensions.recommendations).toEqual(['oxc.oxc-vscode', 'dbaeumer.vscode-eslint']);
  });
});

test('does not create .vscode/extensions.json and leaves Java repositories untouched', async () => {
  await withTempDir(async (tempDirPath) => {
    await fixVscodeExtensions(createConfig({ dirPath: tempDirPath }));
    await promisePool.promiseAll();
    expect(fs.existsSync(path.join(tempDirPath, '.vscode', 'extensions.json'))).toBe(false);

    const extensionsPath = path.join(tempDirPath, '.vscode', 'extensions.json');
    fs.mkdirSync(path.dirname(extensionsPath), { recursive: true });
    const content = JSON.stringify({ recommendations: ['esbenp.prettier-vscode'] });
    fs.writeFileSync(extensionsPath, content);
    await fixVscodeExtensions(createConfig({ dirPath: tempDirPath, doesContainJava: true }));
    await promisePool.promiseAll();
    expect(fs.readFileSync(extensionsPath, 'utf8')).toBe(content);
  });
});

test('deletes .idea/prettier.xml except in Java repositories', async () => {
  await withTempDir(async (tempDirPath) => {
    const prettierXmlPath = path.join(tempDirPath, '.idea', 'prettier.xml');
    fs.mkdirSync(path.dirname(prettierXmlPath), { recursive: true });
    fs.writeFileSync(prettierXmlPath, '<project />');
    await generateIdeaSettings(createConfig({ dirPath: tempDirPath, doesContainJava: true }));
    await promisePool.promiseAll();
    expect(fs.existsSync(prettierXmlPath)).toBe(true);

    await generateIdeaSettings(createConfig({ dirPath: tempDirPath }));
    await promisePool.promiseAll();
    expect(fs.existsSync(prettierXmlPath)).toBe(false);
  });
});

test('omits @willbooster/prettier-config from bunfig excludes except in Java repositories', async () => {
  await withTempDir(async (tempDirPath) => {
    await generateBunfigToml(createConfig({ dirPath: tempDirPath }));
    await promisePool.promiseAll();
    const bunfigPath = path.join(tempDirPath, 'bunfig.toml');
    expect(fs.readFileSync(bunfigPath, 'utf8')).not.toContain('@willbooster/prettier-config');

    await generateBunfigToml(createConfig({ dirPath: tempDirPath, doesContainJava: true }));
    await promisePool.promiseAll();
    expect(fs.readFileSync(bunfigPath, 'utf8')).toContain('@willbooster/prettier-config');
  });
});

async function withTempDir(testBody: (tempDirPath: string) => Promise<void>): Promise<void> {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-prettier-migration-')));
  try {
    await testBody(tempDirPath);
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
}
