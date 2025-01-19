import fs from 'node:fs';
import path from 'node:path';

import type { Glob } from 'bun';

/**
 * Represents a file system entry with name and parent path information.
 */
type NodeJsDirentLike = {
  /** The name of the file or directory */
  name: string;
  /** The absolute path to the parent directory */
  parentPath: string;
};

/**
 * Asynchronously glob for files and directories.
 * @param pattern - The glob pattern to match files and directories
 * @param options - Configuration options for globbing
 * @param options.cwd - The working directory to start globbing from
 * @param options.excludes - Regular expressions to exclude from the results
 * @param options.onlyFiles - If true, only return files (not directories)
 * @returns An async iterator of matching files and directories
 */
export async function* glob(
  pattern: string,
  options: { cwd?: string; excludes?: RegExp[]; onlyFiles: boolean }
): NodeJS.AsyncIterator<NodeJsDirentLike> {
  // cf. https://bun.sh/guides/util/detect-bun
  if (process.versions.bun) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports,unicorn/prefer-module
    const bun = require(String('bun'));
    const bunGlob = new bun.Glob(pattern) as Glob;
    for await (const direntPath of bunGlob.scan({ cwd: options.cwd, onlyFiles: options.onlyFiles })) {
      const parsedDirentPath = path.parse(direntPath);
      const dirent = {
        name: parsedDirentPath.base,
        parentPath: path.resolve(options.cwd ?? '.', parsedDirentPath.dir),
      };
      if (isExcluded(dirent, options.excludes)) continue;

      yield dirent;
    }
  } else {
    for await (const dirent of fs.promises.glob(pattern, {
      ...options,
      exclude: options.excludes?.length ? (dirent) => isExcluded(dirent, options.excludes) : undefined,
      withFileTypes: true,
    })) {
      if (options.onlyFiles && !dirent.isFile()) continue;
      // We need double-check here because files are ignored by `exclude` option.
      if (dirent.isFile() && isExcluded(dirent, options.excludes)) continue;

      yield dirent;
    }
  }
}

/**
 * Synchronously glob for files and directories.
 * @param pattern - The glob pattern to match files and directories
 * @param options - Configuration options for globbing
 * @param options.cwd - The working directory to start globbing from
 * @param options.excludes - Regular expressions to exclude from the results
 * @param options.onlyFiles - If true, only return files (not directories)
 * @returns An array of matching files and directories
 */
export function globSync(
  pattern: string,
  options: { cwd?: string; excludes?: RegExp[]; onlyFiles: boolean }
): NodeJsDirentLike[] {
  // cf. https://bun.sh/guides/util/detect-bun
  if (process.versions.bun) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports,unicorn/prefer-module
    const bun = require(String('bun'));
    const bunGlob = new bun.Glob(pattern) as Glob;
    const dirents: NodeJsDirentLike[] = [];
    for (const direntPath of bunGlob.scanSync({ cwd: options.cwd, onlyFiles: options.onlyFiles })) {
      const parsedDirentPath = path.parse(direntPath);
      const dirent = {
        name: parsedDirentPath.base,
        parentPath: path.resolve(options.cwd ?? '.', parsedDirentPath.dir),
      };
      if (isExcluded(dirent, options.excludes)) continue;

      dirents.push(dirent);
    }
    return dirents;
  } else {
    return (
      fs
        .globSync(pattern, {
          ...options,
          exclude: options.excludes ? (dirent) => isExcluded(dirent, options.excludes) : undefined,
          withFileTypes: true,
        })
        // We need double-check here because files are ignored by `exclude` option.
        .filter(
          (dirent) =>
            !(options.onlyFiles && !dirent.isFile()) && !(dirent.isFile() && isExcluded(dirent, options.excludes))
        )
    );
  }
}

function isExcluded(dirent: NodeJsDirentLike, excludes?: RegExp[]): boolean {
  if (!excludes) return false;

  const targetPath = path.join(dirent.parentPath, dirent.name).replaceAll('\\', '/');
  return excludes.some((pattern) => pattern.test(targetPath));
}
