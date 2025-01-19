import fs from 'node:fs';
import path from 'node:path';

import type { Glob } from 'bun';

type NodeJsDirentLike = {
  name: string;
  parentPath: string;
};

export async function* glob(
  pattern: string,
  options: { cwd?: string; excludes?: string[]; onlyFiles: boolean }
): NodeJS.AsyncIterator<NodeJsDirentLike> {
  // cf. https://bun.sh/guides/util/detect-bun
  if (process.versions.bun) {
    const bun = await import('bun');
    const bunGlob = new bun.Glob(pattern);
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
    for await (const dirent of fs.promises.glob(pattern, { ...options, withFileTypes: true })) {
      if (options.onlyFiles && !dirent.isFile()) continue;
      if (isExcluded(dirent, options.excludes)) continue;

      yield dirent;
    }
  }
}

export function globSync(
  pattern: string,
  options: { cwd?: string; excludes?: string[]; onlyFiles: boolean }
): NodeJsDirentLike[] {
  // cf. https://bun.sh/guides/util/detect-bun
  if (process.versions.bun) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports,unicorn/prefer-module
    const bun = require('bun');
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
    return fs
      .globSync(pattern, { ...options, withFileTypes: true })
      .filter((dirent) => (!options.onlyFiles || dirent.isFile()) && !isExcluded(dirent, options.excludes));
  }
}

function isExcluded(dirent: NodeJsDirentLike, excludes?: string[]): boolean | undefined {
  return excludes?.some((exclude) => {
    const pattern = exclude.replaceAll('\\', '/');
    return path.join(dirent.parentPath, dirent.name).replaceAll('\\', '/').includes(pattern);
  });
}
