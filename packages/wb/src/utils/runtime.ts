export const isRunningOnBun =
  // Detect `bun --bun run wb ...`. cf. https://bun.sh/guides/util/detect-bun
  process.versions.bun ||
  // Detect `bun run wb ...`.
  process.argv[0]?.endsWith('/bun') ||
  process.env.npm_execpath?.endsWith('/bun');

export const runtimeWithArgs = isRunningOnBun ? 'bun --bun run' : 'node';
export const packageManager = isRunningOnBun ? 'bun' : 'yarn';
export const packageManagerWithRun = isRunningOnBun ? 'bun --bun run' : 'yarn';
