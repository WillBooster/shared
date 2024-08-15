export const isRunningOnBun = process.argv[0].endsWith('/bun') || process.env.npm_execpath?.endsWith('/bun');

export const runtimeWithArgs = isRunningOnBun ? 'bun --bun run' : 'node';
export const packageManager = isRunningOnBun ? 'bun' : 'yarn';
export const packageManagerWithRun = isRunningOnBun ? 'bun --bun run' : 'yarn';
