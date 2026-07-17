import fs from 'node:fs';
import path from 'node:path';

export const fsUtil = {
  async readFileIgnoringError(filePath: string): Promise<string | undefined> {
    try {
      return await fs.promises.readFile(filePath, 'utf8');
    } catch {
      // do nothing
    }
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
  async generateFile(filePath: string, content: string): Promise<void> {
    // Never write through a symlink: a (possibly dangling) link committed in the target repository
    // could redirect the write outside it.
    const stats = await fs.promises.lstat(filePath).catch(() => {});
    if (stats?.isSymbolicLink()) {
      console.warn(`Skipped generating ${filePath} because it is a symbolic link.`);
      return;
    }
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    let normalizedContent = content.trim();
    if (normalizedContent) {
      normalizedContent += '\n';
    }
    await fs.promises.writeFile(filePath, normalizedContent);
    console.log(`Generated/Updated ${filePath}`);
  },
};
