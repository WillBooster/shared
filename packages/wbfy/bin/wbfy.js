#!/usr/bin/env bun

import child_process from 'node:child_process';
import fs from 'node:fs';

const { minimumBunVersion } = JSON.parse(
  fs.readFileSync(new URL('../configs/runtime.json', import.meta.url), 'utf8')
);

if (Bun.semver.order(Bun.version, minimumBunVersion) < 0) {
  // Re-enter through mise before loading the Bun 1.4-only bundle. Managed repositories can still
  // pin the previous runtime on the first wbfy run that raises this floor.
  const result = child_process.spawnSync(
    'mise',
    ['exec', `bun@${minimumBunVersion}`, '--', 'bun', process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit' }
  );
  if (result.error) console.error(`Failed to start Bun ${minimumBunVersion} through mise: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

await import('../dist/index.js');
