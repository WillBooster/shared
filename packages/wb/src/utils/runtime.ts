// cf. https://bun.sh/guides/util/detect-bun
export const isRunningOnBun = Boolean(process.versions.bun);

export const runtimeWithArgs = isRunningOnBun ? 'bun --bun run' : 'node';
export const packageManager = isRunningOnBun ? 'bun' : 'yarn';
export const packageManagerWithRun = isRunningOnBun ? 'bun --bun run' : 'yarn';
