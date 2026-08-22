import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { generateGeminiConfig } from '../../src/generators/geminiConfig.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { createConfig } from '../helpers/testConfig.js';

test('writes .gemini/config.yaml (the only filename Gemini Code Assist reads), migrating and deleting a legacy config.yml', async () => {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-gemini-')));
  try {
    const geminiDirPath = path.join(tempDirPath, '.gemini');
    fs.mkdirSync(geminiDirPath, { recursive: true });
    // A repository customization stored under the legacy filename must survive the rename.
    fs.writeFileSync(path.join(geminiDirPath, 'config.yml'), 'custom_key: custom-value\n');

    const config = createConfig({ dirPath: tempDirPath, isRoot: true });
    await generateGeminiConfig(config, [config]);
    await promisePool.promiseAll();

    const yamlContent = fs.readFileSync(path.join(geminiDirPath, 'config.yaml'), 'utf8');
    expect(yamlContent).toContain('custom_key: custom-value');
    expect(fs.existsSync(path.join(geminiDirPath, 'config.yml'))).toBe(false);
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});

test('prefers an existing config.yaml over a stale legacy config.yml as the merge source', async () => {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-gemini2-')));
  try {
    const geminiDirPath = path.join(tempDirPath, '.gemini');
    fs.mkdirSync(geminiDirPath, { recursive: true });
    fs.writeFileSync(path.join(geminiDirPath, 'config.yaml'), 'custom_key: from-yaml\n');
    fs.writeFileSync(path.join(geminiDirPath, 'config.yml'), 'custom_key: from-yml\n');

    const config = createConfig({ dirPath: tempDirPath, isRoot: true });
    await generateGeminiConfig(config, [config]);
    await promisePool.promiseAll();

    const yamlContent = fs.readFileSync(path.join(geminiDirPath, 'config.yaml'), 'utf8');
    expect(yamlContent).toContain('custom_key: from-yaml');
    expect(yamlContent).not.toContain('from-yml');
    expect(fs.existsSync(path.join(geminiDirPath, 'config.yml'))).toBe(false);
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});

test('does not resurrect legacy settings when config.yaml exists but is comment-only', async () => {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-gemini3-')));
  try {
    const geminiDirPath = path.join(tempDirPath, '.gemini');
    fs.mkdirSync(geminiDirPath, { recursive: true });
    fs.writeFileSync(path.join(geminiDirPath, 'config.yaml'), '# intentionally reset to defaults\n');
    fs.writeFileSync(path.join(geminiDirPath, 'config.yml'), 'custom_key: from-legacy\n');

    const config = createConfig({ dirPath: tempDirPath, isRoot: true });
    await generateGeminiConfig(config, [config]);
    await promisePool.promiseAll();

    const yamlContent = fs.readFileSync(path.join(geminiDirPath, 'config.yaml'), 'utf8');
    expect(yamlContent).not.toContain('from-legacy');
    expect(fs.existsSync(path.join(geminiDirPath, 'config.yml'))).toBe(false);
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});

test('keeps the legacy config.yml when the config.yaml write is skipped (symlink destination)', async () => {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-gemini4-')));
  try {
    const geminiDirPath = path.join(tempDirPath, '.gemini');
    fs.mkdirSync(geminiDirPath, { recursive: true });
    // A (dangling) committed symlink makes generateFile skip the write; the migration source must
    // survive so the repository still has its only usable configuration.
    fs.symlinkSync(path.join(tempDirPath, 'missing-target.yaml'), path.join(geminiDirPath, 'config.yaml'));
    fs.writeFileSync(path.join(geminiDirPath, 'config.yml'), 'custom_key: only-copy\n');

    const config = createConfig({ dirPath: tempDirPath, isRoot: true });
    await generateGeminiConfig(config, [config]);
    await promisePool.promiseAll();

    expect(fs.existsSync(path.join(geminiDirPath, 'config.yml'))).toBe(true);
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
});
