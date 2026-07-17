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
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    let normalizedContent = content.trim();
    if (normalizedContent) {
      normalizedContent += '\n';
    }
    await fs.promises.writeFile(filePath, normalizedContent);
    console.log(`Generated/Updated ${filePath}`);
  },
};
