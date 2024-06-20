export const isRunningOnBun = process.argv[0].endsWith('/bun') || process.env.npm_execpath?.endsWith('/bun');

export const runtimeWithArgs = isRunningOnBun ? 'bun --bun run' : 'node';
export const packageManagerWithArgs = isRunningOnBun ? 'bun --bun run' : 'yarn';
