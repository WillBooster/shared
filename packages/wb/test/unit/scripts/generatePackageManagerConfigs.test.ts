import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docker/bash/generate-package-manager-configs.sh'
);

// The wbfy-generated bunfig.toml format (see packages/wbfy/src/generators/bunfig.ts) is the only
// supported input.
const wbfyGeneratedBunfig = `env = false
telemetry = false

[test]
preload = ["./test/preload.ts"]

[install]
exact = false
globalStore = true
linker = "isolated"
minimumReleaseAge = 604800
`;

it('drops the [test] sections and forces globalStore off', async () => {
  const workDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-pm-configs-'));
  try {
    await fs.writeFile(path.join(workDirPath, 'bunfig.toml'), wbfyGeneratedBunfig);

    const ret = childProcess.spawnSync('bash', [scriptPath], { cwd: workDirPath, stdio: 'inherit' });
    expect(ret.status).toBe(0);

    await expect(fs.readFile(path.join(workDirPath, 'bunfig.toml'), 'utf8')).resolves.toBe(
      `env = false
telemetry = false

[install]
exact = false
globalStore = false
linker = "isolated"
minimumReleaseAge = 604800
`
    );
  } finally {
    await fs.rm(workDirPath, { force: true, recursive: true });
  }
});

it('fails fast on a bunfig.toml not regenerated since wbfy introduced the release-age gate', async () => {
  const workDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-pm-configs-'));
  try {
    await fs.writeFile(path.join(workDirPath, 'bunfig.toml'), 'env = false\n\n[install]\nexact = true\n');

    const ret = childProcess.spawnSync('bash', [scriptPath], { cwd: workDirPath, encoding: 'utf8' });
    expect(ret.status).toBe(1);
    expect(ret.stderr).toContain('minimumReleaseAge');
  } finally {
    await fs.rm(workDirPath, { force: true, recursive: true });
  }
});
