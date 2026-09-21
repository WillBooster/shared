#!/usr/bin/env bun

import { fileURLToPath } from 'node:url';

const minimumBunVersion = '1.4.0';
const applyReleaseAgeGateCommand = 'apply-release-age-gate';
const globalBooleanOptionNames = new Set([
  '--force',
  '--skipDeps',
  '--skip-deps',
  '--verbose',
  '--f',
  '--d',
  '--v',
]);

if (!isSupportedBunVersion(Bun.version)) {
  const releaseAgeGateApplied = applyReleaseAgeGate();
  if (isApplyReleaseAgeGateInvocation(process.argv.slice(2))) {
    process.exit(releaseAgeGateApplied ? 0 : 1);
  }
  process.exit(runWithSupportedBun());
}

await import('../dist/index.js');

function runWithSupportedBun() {
  const cwd = process.cwd();
  let latestResult;
  try {
    latestResult = Bun.spawnSync(['mise', '--no-config', 'latest', 'bun'], {
      cwd,
      stdout: 'pipe',
      stderr: 'inherit',
    });
  } catch {
    return reportBootstrapFailure('mise could not resolve a supported version');
  }
  const latestBunVersion = latestResult.stdout.toString().trim();
  if (latestResult.exitCode !== 0 || !isSupportedBunVersion(latestBunVersion)) {
    return reportBootstrapFailure('mise could not resolve a supported version');
  }

  // Use a config-free mise environment so a repository's old Bun pin cannot prevent wbfy from
  // updating that same pin. The relaunched process then performs the complete operation once.
  console.info(`Restart wbfy with Bun ${latestBunVersion} (current: ${Bun.version}).`);
  try {
    const result = Bun.spawnSync(
      ['mise', '--no-config', 'x', `bun@${latestBunVersion}`, '--', 'bun', process.argv[1], ...process.argv.slice(2)],
      { cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }
    );
    return result.exitCode ?? 1;
  } catch {
    return reportBootstrapFailure(`mise could not start Bun ${latestBunVersion}`);
  }
}

function applyReleaseAgeGate() {
  const scriptPath = fileURLToPath(new URL('../configs/applyReleaseAgeGate.sh', import.meta.url));
  try {
    const result = Bun.spawnSync(['bash', scriptPath], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    if (result.exitCode === 0) return true;
  } catch {
    // The warning below is the stable command-level diagnostic for either spawn or script failure.
  }
  console.warn('Failed to apply the minimum-release-age policy to the global package-manager configs.');
  return false;
}

function reportBootstrapFailure(reason) {
  console.error(`wbfy requires Bun >= ${minimumBunVersion} (found ${Bun.version}), but ${reason}.`);
  return 1;
}

function isApplyReleaseAgeGateInvocation(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (isPositiveGlobalBooleanOption(argument)) {
      if (!argument.includes('=') && ['true', 'false'].includes(args[index + 1])) index += 1;
      continue;
    }
    if (isNegatedGlobalBooleanOption(argument)) continue;
    return argument === applyReleaseAgeGateCommand;
  }
  return false;
}

function isPositiveGlobalBooleanOption(argument) {
  if (/^-[fdv]+(?:=.*)?$/.test(argument)) return true;

  const optionName = argument.split('=', 1)[0];
  return globalBooleanOptionNames.has(optionName);
}

function isNegatedGlobalBooleanOption(argument) {
  return argument.startsWith('--no-') && globalBooleanOptionNames.has(`--${argument.slice(5)}`);
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
