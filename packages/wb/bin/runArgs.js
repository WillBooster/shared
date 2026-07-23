const booleanOptionNames = new Set([
  'auto-cascade-env',
  'cascade-node-env',
  'dry-run',
  'dry',
  'd',
  'help',
  'h',
  'include-root-env',
  'quiet-env',
  'verbose',
  'v',
  'version',
]);
const valueOptionNames = new Set(['cascade-env', 'env', 'working-dir', 'w']);
const boundaryMarkerEnvName = 'WB_INTERNAL_RUN_BOUNDARY_MARKER';

export function protectRunScriptArgs(argv) {
  const runIndex = findTopLevelRunIndex(argv);
  if (runIndex === -1) return;

  const scriptIndex = findRunScriptIndex(argv, runIndex + 1);
  if (scriptIndex === undefined || argv[scriptIndex - 1] === '--') return;

  const existingMarker = process.env[boundaryMarkerEnvName];
  if (argv[scriptIndex + 1] === '--') {
    if (existingMarker && argv[scriptIndex + 2] === existingMarker) return;
    delete process.env[boundaryMarkerEnvName];
    return;
  }

  let marker;
  do marker = `__WB_RUN_SCRIPT_ARGS_${randomUUID()}__`;
  while (argv.includes(marker));
  process.env[boundaryMarkerEnvName] = marker;
  argv.splice(scriptIndex + 1, 0, '--', marker);
}

export function getRunScriptArgs(argv) {
  const runIndex = findTopLevelRunIndex(argv);
  if (runIndex === -1) return [];
  const scriptIndex = findRunScriptIndex(argv, runIndex + 1);
  if (scriptIndex === undefined) return [];

  const args = argv.slice(scriptIndex);
  const marker = process.env[boundaryMarkerEnvName];
  if (marker && args[1] === '--' && args[2] === marker) args.splice(1, 2);
  delete process.env[boundaryMarkerEnvName];
  return args;
}

function findTopLevelRunIndex(argv) {
  for (let index = 2; index < argv.length; ) {
    const consumed = countOptionTokens(argv, index);
    if (consumed === 0) return argv[index] === 'run' ? index : -1;
    index += consumed;
  }
  return -1;
}

function findRunScriptIndex(argv, startIndex) {
  for (let index = startIndex; index < argv.length; ) {
    if (argv[index] === '--') return argv[index + 1] === undefined ? undefined : index + 1;
    const consumed = countOptionTokens(argv, index);
    if (consumed === 0) return index;
    index += consumed;
  }
}

function countOptionTokens(argv, index) {
  const arg = argv[index];
  if (!arg?.startsWith('-') || arg === '-') return 0;
  if (arg.startsWith('--')) {
    const optionText = arg.slice(2);
    const equalsIndex = optionText.indexOf('=');
    const rawName = equalsIndex === -1 ? optionText : optionText.slice(0, equalsIndex);
    const name = rawName.startsWith('no-') ? rawName.slice(3) : rawName;
    if (booleanOptionNames.has(name)) {
      return equalsIndex === -1 && isBooleanLiteral(argv[index + 1]) ? 2 : 1;
    }
    if (!valueOptionNames.has(name)) return 0;
    return equalsIndex === -1 ? 2 : 1;
  }

  const shortOptions = arg.slice(1);
  if (/^[dhv]=(false|true)$/.test(shortOptions)) return 1;
  if (/^[dhv]$/.test(shortOptions) && isBooleanLiteral(argv[index + 1])) return 2;
  for (let optionIndex = 0; optionIndex < shortOptions.length; optionIndex++) {
    const name = shortOptions[optionIndex];
    if (booleanOptionNames.has(name)) continue;
    if (valueOptionNames.has(name)) return optionIndex + 1 < shortOptions.length ? 1 : 2;
    return 0;
  }
  return 1;
}

function isBooleanLiteral(value) {
  return value === 'false' || value === 'true';
}
import { randomUUID } from 'node:crypto';
