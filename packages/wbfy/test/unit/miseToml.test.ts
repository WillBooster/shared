import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import semver from 'semver';

import { generateMiseToml, minimumPinnedBunVersion, minimumPinnedNodeVersion } from '../../src/generators/miseToml.js';
import { fsUtil } from '../../src/utils/fsUtil.js';
import { createConfig } from '../helpers/testConfig.js';

// setRootDirPath is process-wide state: leaving a deleted temporary directory behind would confine
// any later test sharing this worker to a repository root that no longer exists.
afterEach(() => {
  fsUtil.setRootDirPath(undefined);
});

async function generateFrom(files: Record<string, string>): Promise<string> {
  fs.mkdirSync('.tmp', { recursive: true });
  const dirPath = fs.mkdtempSync(path.resolve('.tmp', 'wbfy-mise-'));
  try {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    for (const [fileName, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dirPath, fileName), content);
    }
    fsUtil.setRootDirPath(dirPath);
    await generateMiseToml(createConfig({ dirPath }));
    return fs.readFileSync(path.join(dirPath, 'mise.toml'), 'utf8');
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
}

function miseToml(node: string, bun: string, fnoxLine: string): string {
  return `# Toolchain\n[tools]\nnode = "${node}"\nbun = "${bun}" # inline\npython = "3.12.0"\n${fnoxLine}\n# Tasks\n[tasks.hello]\n# Multi-line on purpose.\nrun = """\necho hello\n"""\n`;
}

test('updates Node.js to LTS, Bun, and fnox without downgrading newer pins or rewriting the rest of the file', async () => {
  // Require successful live lookups: accepting original pins would let a broken updater pass.
  const { stdout: latestNodeOutput } = await spawnAsync('mise', ['--no-config', 'latest', 'node@lts']);
  const { stdout: latestBunOutput } = await spawnAsync('mise', ['--no-config', 'latest', 'bun']);
  const { stdout: latestFnoxOutput } = await spawnAsync('mise', ['--no-config', 'latest', 'fnox']);
  const latestNode = semver.rsort([latestNodeOutput.trim(), minimumPinnedNodeVersion])[0] ?? '';
  const latestBun = semver.rsort([latestBunOutput.trim(), minimumPinnedBunVersion])[0] ?? '';
  const latestFnox = latestFnoxOutput.trim();
  const content = await generateFrom({ 'mise.toml': miseToml('24.22.1', '0.1.0', ''), 'fnox.toml': '' });

  expect(content).toBe(miseToml(latestNode, latestBun, `fnox = "${latestFnox}"\n`));
  expect(await generateFrom({ 'mise.toml': content, 'fnox.toml': '' })).toBe(content);

  const newerNode = semver.inc(latestNode, 'patch');
  const newerBun = semver.inc(latestBun, 'patch');
  const newerFnox = semver.inc(latestFnox, 'patch');
  const newerContent = await generateFrom({
    'mise.toml': `[tools]\nnode = "${newerNode}"\nbun = "${newerBun}"\nfnox = "${newerFnox}"\n`,
    'fnox.toml': '',
  });
  expect(Bun.TOML.parse(newerContent)).toEqual({
    tools: { node: newerNode, bun: newerBun, fnox: newerFnox },
  });
}, 60_000);
