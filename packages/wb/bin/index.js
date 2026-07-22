#!/usr/bin/env node

protectRunScriptArgs(process.argv);

if (process.argv[2] === 'dotenv') {
  const { runDotenvCommand } = await import('./dotenv.js');
  await runDotenvCommand(process.argv.slice(3));
} else {
  await import('../dist/index.js');
}

function protectRunScriptArgs(argv) {
  const runIndex = argv.indexOf('run', 2);
  if (runIndex === -1) return;

  const scriptIndex = findRunScriptIndex(argv, runIndex + 1);
  if (scriptIndex === undefined || argv[scriptIndex - 1] === '--' || argv.includes('--', scriptIndex + 1)) return;
  argv.splice(scriptIndex + 1, 0, '--');
}

function findRunScriptIndex(argv, startIndex) {
  const booleanOptions = new Set([
    '--auto-cascade-env',
    '--cascade-node-env',
    '--dry-run',
    '--dry',
    '-d',
    '--help',
    '-h',
    '--include-root-env',
    '--quiet-env',
    '--verbose',
    '-v',
    '--version',
  ]);
  const valueOptions = new Set(['--cascade-env', '--check-env', '--env', '--working-dir', '-w']);
  for (let index = startIndex; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') return argv[index + 1] === undefined ? undefined : index + 1;
    if (booleanOptions.has(arg) || [...booleanOptions].some((option) => arg.startsWith(`${option}=`))) continue;
    if ([...valueOptions].some((option) => arg.startsWith(`${option}=`))) continue;
    if (valueOptions.has(arg)) {
      index++;
      continue;
    }
    return index;
  }
}
