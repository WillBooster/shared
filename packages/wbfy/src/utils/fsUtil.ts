import fs from 'node:fs';
import path from 'node:path';

let realRootDirPath: string | undefined;

export const fsUtil = {
  /** Confines generateFile writes to the repository rooted at rootDirPath (undefined disables it). */
  setRootDirPath(rootDirPath: string | undefined): void {
    realRootDirPath = rootDirPath === undefined ? undefined : fs.realpathSync(rootDirPath);
  },
  /**
   * Returns undefined only when the file does not exist. Other failures (e.g. permissions) are
   * rethrown so callers regenerating config files never overwrite content they could not read.
   */
  async readFileIfExists(filePath: string): Promise<string | undefined> {
    try {
      return await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  },
  /** Tells whether a write to filePath would pass the symlink/repository-containment guards. */
  async isConfinedWritablePath(filePath: string): Promise<boolean> {
    return await isConfinedWritablePath(filePath);
  },
  /**
   * Reads a migration source, returning undefined when the file does not exist OR when it is a
   * symlink / resolves outside the repository — a committed symlink pointing outside the
   * repository must not get its target's content copied into a tracked file.
   */
  async readFileConfinedIfExists(filePath: string): Promise<string | undefined> {
    const stats = await fs.promises.lstat(filePath).catch(() => {});
    if (!stats) return undefined;
    if (stats.isSymbolicLink()) {
      console.warn(`Skipped reading ${filePath} because it is a symbolic link.`);
      return undefined;
    }
    if (!(await hasConfinedParent(filePath))) {
      console.warn(`Skipped reading ${filePath} because it resolves outside the repository.`);
      return undefined;
    }
    return await fsUtil.readFileIfExists(filePath);
  },
  /**
   * Removes filePath (force, optionally recursive) only when its PARENT directory resolves inside
   * the repository, so a symlinked directory (e.g. a committed .github/workflows link) can never
   * make cleanup delete files outside the repository. Removing a symlink entry itself is allowed:
   * that deletes only the link, never its target. Returns whether the removal was performed.
   */
  async removeConfined(filePath: string, options?: { recursive?: boolean }): Promise<boolean> {
    if (!(await hasConfinedParent(filePath))) {
      console.warn(`Skipped removing ${filePath} because it resolves outside the repository.`);
      return false;
    }
    await fs.promises.rm(filePath, { force: true, recursive: options?.recursive ?? false });
    return true;
  },
  /** Writes content verbatim, applying the same symlink/repository-containment guards as generateFile. */
  async writeFileConfined(filePath: string, content: string): Promise<boolean> {
    if (!(await isConfinedWritablePath(filePath))) return false;
    await fs.promises.writeFile(filePath, content);
    return true;
  },
  /** Returns whether the file was actually generated (false when the confinement guards skip it). */
  async generateFile(filePath: string, content: string): Promise<boolean> {
    if (!(await isConfinedWritablePath(filePath))) return false;
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    let normalizedContent = content.trim();
    if (normalizedContent) {
      normalizedContent += '\n';
    }
    await fs.promises.writeFile(filePath, normalizedContent);
    console.log(`Generated/Updated ${filePath}`);
    return true;
  },
};

async function isConfinedWritablePath(filePath: string): Promise<boolean> {
  // Never write through a symlink: a (possibly dangling) link committed in the target repository
  // could redirect the write outside it.
  const stats = await fs.promises.lstat(filePath).catch(() => {});
  if (stats?.isSymbolicLink()) {
    console.warn(`Skipped writing ${filePath} because it is a symbolic link.`);
    return false;
  }
  if (!(await hasConfinedParent(filePath))) {
    console.warn(`Skipped writing ${filePath} because it resolves outside the repository.`);
    return false;
  }
  return true;
}

// A symlinked parent directory would redirect reads, writes, and removals outside the repository,
// so require the closest existing ancestor to resolve inside the root set by the CLI entry point.
async function hasConfinedParent(filePath: string): Promise<boolean> {
  if (realRootDirPath === undefined) return true;
  let ancestorPath = path.dirname(filePath);
  while (!fs.existsSync(ancestorPath)) {
    ancestorPath = path.dirname(ancestorPath);
  }
  const realAncestorPath = await fs.promises.realpath(ancestorPath);
  return realAncestorPath === realRootDirPath || realAncestorPath.startsWith(realRootDirPath + path.sep);
}
