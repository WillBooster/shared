import { API } from 'typescript/unstable/async';
import type { SourceFile } from 'typescript/unstable/ast';

// TypeScript 7 ships the native (Go) compiler as the `typescript` package and no
// longer exposes an in-process parser such as `ts.createSourceFile`. Parsing now
// happens in a spawned compiler server reached through the asynchronous API, so we
// keep a single lazily-created instance and reuse it across every fixer to avoid
// paying the process-spawn cost per file.
let api: API | undefined;

function getApi(): API {
  return (api ??= new API({ cwd: process.cwd() }));
}

/**
 * Parses a source file into a TypeScript AST using the bundled native compiler.
 * Returns `undefined` when the compiler cannot load the file (e.g. it is missing
 * or unparsable) so callers can fall back to conservative behavior.
 */
export async function parseSourceFile(filePath: string): Promise<SourceFile | undefined> {
  try {
    const snapshot = await getApi().updateSnapshot({ openFiles: [filePath] });
    const project = await snapshot.getDefaultProjectForFile(filePath);
    return await project?.program.getSourceFile(filePath);
  } catch {
    return undefined;
  }
}

/**
 * Shuts down the spawned compiler server. The server keeps an open IPC channel
 * that would otherwise keep the runtime event loop alive, so wbfy must call this
 * once its run finishes for the process to exit.
 */
export async function disposeTypeScriptApi(): Promise<void> {
  await api?.close();
  api = undefined;
}
