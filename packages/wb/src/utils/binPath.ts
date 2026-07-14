import fs from 'node:fs';
import path from 'node:path';

/**
 * Prepend every existing `node_modules/.bin` directory from the given directory up to the
 * repository root (or filesystem root) to the environment's PATH. Needed wherever wb strips
 * yarn's temporary bin folder from PATH (yarn Berry exposes dependency executables only
 * through that folder, never through `node_modules/.bin` on PATH), so that bare binary names
 * in wrapped commands keep resolving.
 */
export function prependNodeModulesBinToPath(dirPath: string, env: Record<string, string | undefined>): boolean {
  let binFound = false;
  let currentPath = path.resolve(dirPath);
  for (;;) {
    const binPath = path.join(currentPath, 'node_modules', '.bin');
    if (fs.existsSync(binPath)) {
      env.PATH = `${binPath}:${env.PATH}`;
      binFound = true;
    }

    if (fs.existsSync(path.join(currentPath, '.git'))) {
      break;
    }
    const parentPath = path.dirname(currentPath);
    if (currentPath === parentPath) {
      break;
    }
    currentPath = parentPath;
  }
  return binFound;
}
