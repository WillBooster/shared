#!/usr/bin/env bun

const minimumBunVersion = '1.4.0';

if (!isSupportedBunVersion(Bun.version)) {
  process.exit(runWithSupportedBun());
}

await import('../dist/index.js');

function runWithSupportedBun() {
  const cwd = process.cwd();
  const latestResult = Bun.spawnSync(['mise', '--no-config', 'latest', 'bun'], {
    cwd,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const latestBunVersion = latestResult.stdout.toString().trim();
  if (latestResult.exitCode !== 0 || !isSupportedBunVersion(latestBunVersion)) {
    console.error(
      `wbfy requires Bun >= ${minimumBunVersion} (found ${Bun.version}), but mise could not resolve a supported version.`
    );
    return 1;
  }

  // Use a config-free mise environment so a repository's old Bun pin cannot prevent wbfy from
  // updating that same pin. The relaunched process then performs the complete operation once.
  console.info(`Restart wbfy with Bun ${latestBunVersion} (current: ${Bun.version}).`);
  const result = Bun.spawnSync(
    ['mise', '--no-config', 'x', `bun@${latestBunVersion}`, '--', 'bun', process.argv[1], ...process.argv.slice(2)],
    { cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }
  );
  return result.exitCode ?? 1;
}

function isSupportedBunVersion(version) {
  const current = version.split('.').map(Number);
  const minimum = minimumBunVersion.split('.').map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    const difference = (current[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}
