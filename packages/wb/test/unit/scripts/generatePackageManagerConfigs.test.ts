import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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
publicHoistPattern = ["tsx", "undici-types"]
minimumReleaseAge = 604800 # 7 days
# minimumReleaseAge and minimumReleaseAgeExcludes are managed by wbfy — repository-specific
# changes are prohibited and overwritten on every run.
minimumReleaseAgeExcludes = [
    "@willbooster/wb",
    "at-decorators",
]
`;

describe('generate-package-manager-configs.sh', () => {
  it('force-overwrites the npm / yarn / bun configs with the org-standard content', async () => {
    const workDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-pm-configs-'));
    const homeDirPath = path.join(workDirPath, 'home');
    await fs.mkdir(homeDirPath);
    await fs.writeFile(path.join(homeDirPath, '.npmrc'), 'registry=https://example.com/\n');
    await fs.writeFile(path.join(workDirPath, 'bunfig.toml'), wbfyGeneratedBunfig);

    const ret = childProcess.spawnSync('bash', [scriptPath], {
      cwd: workDirPath,
      env: { ...process.env, HOME: homeDirPath },
      stdio: 'inherit',
    });
    expect(ret.status).toBe(0);

    await expect(fs.readFile(path.join(homeDirPath, '.npmrc'), 'utf8')).resolves.toBe(
      `min-release-age=7
min-release-age-exclude[]=@willbooster/wb
min-release-age-exclude[]=at-decorators
`
    );
    await expect(fs.readFile(path.join(homeDirPath, '.yarnrc.yml'), 'utf8')).resolves.toBe(
      `npmMinimalAgeGate: 10080 # 7 days
npmPreapprovedPackages:
  - '@willbooster/wb'
  - 'at-decorators'
`
    );
    await expect(fs.readFile(path.join(workDirPath, 'bunfig.toml'), 'utf8')).resolves.toBe(
      `env = false
telemetry = false

[install]
exact = false
globalStore = false
linker = "isolated"
publicHoistPattern = ["tsx", "undici-types"]
minimumReleaseAge = 604800 # 7 days
# minimumReleaseAge and minimumReleaseAgeExcludes are managed by wbfy — repository-specific
# changes are prohibited and overwritten on every run.
minimumReleaseAgeExcludes = [
    "@willbooster/wb",
    "at-decorators",
]
`
    );

    await fs.rm(workDirPath, { force: true, recursive: true });
  });

  it('fails fast on a bunfig.toml not regenerated since wbfy introduced the release-age gate', async () => {
    const workDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-pm-configs-'));
    const homeDirPath = path.join(workDirPath, 'home');
    await fs.mkdir(homeDirPath);
    await fs.writeFile(path.join(workDirPath, 'bunfig.toml'), 'env = false\n\n[install]\nexact = true\n');

    const ret = childProcess.spawnSync('bash', [scriptPath], {
      cwd: workDirPath,
      env: { ...process.env, HOME: homeDirPath },
      encoding: 'utf8',
    });
    expect(ret.status).toBe(1);
    expect(ret.stderr).toContain('minimumReleaseAge');

    await fs.rm(workDirPath, { force: true, recursive: true });
  });
});
