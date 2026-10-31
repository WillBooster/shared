import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import releaseAgeGate from '../../configs/releaseAgeGate.json' with { type: 'json' };
import { generateCargoConfigToml } from '../../src/generators/cargoConfigToml.js';
import { fsUtil } from '../../src/utils/fsUtil.js';
import { createConfig } from '../helpers/testConfig.js';

afterEach(() => {
  fsUtil.setRootDirPath(undefined);
});

async function generateFrom(content: string | undefined): Promise<string> {
  fs.mkdirSync('.tmp', { recursive: true });
  const dirPath = fs.mkdtempSync(path.resolve('.tmp', 'wbfy-cargo-config-'));
  try {
    const filePath = path.join(dirPath, '.cargo', 'config.toml');
    if (content !== undefined) {
      fs.mkdirSync(path.dirname(filePath));
      fs.writeFileSync(filePath, content);
    }
    fsUtil.setRootDirPath(dirPath);
    await generateCargoConfigToml(createConfig({ dirPath, isRoot: true, cargoTomlDirPaths: ['src-tauri'] }));
    return fs.readFileSync(filePath, 'utf8');
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
}

const gateLine = `global-min-publish-age = "${releaseAgeGate.days} days"`;

test('gates crates by publish age while keeping the rest of an existing .cargo/config.toml', async () => {
  expect(await generateFrom(undefined)).toBe(`[registry]\n${gateLine}\n`);

  const existing = `# Build settings\n[build]\ntarget-dir = "target"\n\n[registry]\ndefault = "crates-io"\n\n# Aliases\n[alias]\nb = "build"\n`;
  const generated = await generateFrom(existing);
  expect(generated).toBe(existing.replace('default = "crates-io"\n', `default = "crates-io"\n${gateLine}\n`));
  expect(await generateFrom(generated)).toBe(generated);

  expect(await generateFrom(`[registry]\nglobal-min-publish-age = "0"\n`)).toBe(`[registry]\n${gateLine}\n`);

  const commentedHeader = `[registry] # crates.io only\ndefault = "crates-io"\n`;
  expect(await generateFrom(commentedHeader)).toBe(`${commentedHeader}${gateLine}\n`);
});
