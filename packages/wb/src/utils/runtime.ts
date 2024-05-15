export const isRunningOnBun = process.argv[0].endsWith('/bun');

export const runtimeWithArgs = isRunningOnBun ? 'bun --bun' : 'node';
export const packageManagerWithArgs = isRunningOnBun ? 'bun --bun' : 'yarn';
