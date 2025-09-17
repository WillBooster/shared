export const isRunningOnBun =
  // Detect `bun --bun run wb ...`. cf. https://bun.sh/guides/util/detect-bun
  process.versions.bun ||
  // Detect `bun run wb ...`.
  process.argv[0]?.endsWith('/bun') ||
  process.env.npm_execpath?.endsWith('/bun');

export const runtimeWithArgs = isRunningOnBun ? 'bun --bun run' : 'node';
export const packageManager = isRunningOnBun ? 'bun' : 'yarn';
export const packageManagerWithRun = isRunningOnBun ? 'bun --bun run' : 'yarn';

/**
 * Returns the appropriate PM2 command based on the CI environment.
 * Uses pm2-runtime when CI is enabled, pm2 otherwise.
 */
export const pm2Command = process.env.CI ? 'pm2-runtime' : 'pm2';
