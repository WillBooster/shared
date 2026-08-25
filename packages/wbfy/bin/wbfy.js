#!/usr/bin/env bun

import child_process from 'node:child_process';
import fs from 'node:fs';

const { minimumBunVersion } = JSON.parse(
  fs.readFileSync(new URL('../configs/runtime.json', import.meta.url), 'utf8')
);
const bootstrapMarker = 'WBFY_BUN_BOOTSTRAPPED';
const autoInstallMarker = 'WBFY_MISE_EXEC_AUTO_INSTALL';
const originalAutoInstall = process.env[autoInstallMarker];
if (originalAutoInstall !== undefined) {
  if (originalAutoInstall) process.env.MISE_EXEC_AUTO_INSTALL = originalAutoInstall;
  else delete process.env.MISE_EXEC_AUTO_INSTALL;
  delete process.env[autoInstallMarker];
}

if (Bun.semver.order(Bun.version, minimumBunVersion) < 0) {
  const bootstrapStage = process.env[bootstrapMarker];
  if (bootstrapStage === 'minimum') {
    console.error(`mise did not provide Bun ${minimumBunVersion} (still running ${Bun.version}).`);
    process.exit(1);
  }
  // Prefer a supported target pin so every descendant Bun command uses that same version. A target
  // still on the previous runtime needs one fallback to the new floor so wbfy can migrate its pin.
  // With auto-install disabled, mise can fall back to the old Bun on PATH; the stages bound that
  // re-entry to one target attempt and one explicit-minimum attempt.
  const useMinimum = bootstrapStage === 'target';
  const env = { ...process.env, [bootstrapMarker]: useMinimum ? 'minimum' : 'target' };
  if (!useMinimum) {
    env[autoInstallMarker] = process.env.MISE_EXEC_AUTO_INSTALL ?? '';
    env.MISE_EXEC_AUTO_INSTALL = 'false';
  }
  const result = child_process.spawnSync(
    'mise',
    [
      'exec',
      ...(useMinimum ? [`bun@${minimumBunVersion}`] : []),
      '--',
      'bun',
      process.argv[1],
      ...process.argv.slice(2),
    ],
    { env, stdio: 'inherit' }
  );
  if (result.error) console.error(`Failed to start Bun ${minimumBunVersion} through mise: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

await import('../dist/index.js');
