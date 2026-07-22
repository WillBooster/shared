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
const valueOptionNames = new Set(['cascade-env', 'check-env', 'env', 'working-dir', 'w']);
const insertedBoundaryMarker = '__WB_RUN_SCRIPT_ARGS__';

export function protectRunScriptArgs(argv) {
  const runIndex = findTopLevelRunIndex(argv);
  if (runIndex === -1) return;

  const scriptIndex = findRunScriptIndex(argv, runIndex + 1);
  if (scriptIndex === undefined || argv[scriptIndex - 1] === '--' || argv[scriptIndex + 1] === '--') return;
  argv.splice(scriptIndex + 1, 0, '--', insertedBoundaryMarker);
}

export function getRunScriptArgs(argv) {
  const runIndex = findTopLevelRunIndex(argv);
  if (runIndex === -1) return [];
  const scriptIndex = findRunScriptIndex(argv, runIndex + 1);
  if (scriptIndex === undefined) return [];

  const args = argv.slice(scriptIndex);
  if (args[1] === '--' && args[2] === insertedBoundaryMarker) args.splice(1, 2);
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
