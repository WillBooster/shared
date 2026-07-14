export const isRunningOnBun =
  // Detect `bun --bun run wb ...`. cf. https://bun.sh/guides/util/detect-bun
  process.versions.bun ||
  // Detect `bun run wb ...`.
  process.argv[0]?.endsWith('/bun') ||
  process.env.npm_execpath?.endsWith('/bun');

// No `--bun`: its node->bun PATH shim leaks into every child process and breaks tools requiring
// real Node.js (Playwright, wrangler, vinext). wb opts into the bun runtime explicitly where it
// helps (e.g. `bun src/index.ts`).
export const runtimeWithArgs = isRunningOnBun ? 'bun run' : 'node';
export const packageManager = isRunningOnBun ? 'bun' : 'yarn';
export const packageManagerWithRun = isRunningOnBun ? 'bun run' : 'yarn';
