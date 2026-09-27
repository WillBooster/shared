import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isErrnoException } from './errno.js';

/**
 * Writes a file through a uniquely named temporary file in the same directory and a rename, so concurrent readers
 * see either the old or the new content, never a partial one, and concurrent writers never share a temporary file.
 * The file gets `options.mode` exactly (without the umask), or else keeps the permissions of the file it replaces, as
 * an in-place `writeFile` would; a new file without `options.mode` gets the default permissions.
 * Creates missing parent directories. The data is not fsynced, so a power loss can still lose the latest write.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options?: { mode?: number }
): Promise<void> {
  const dirPath = path.dirname(filePath);
  const [mode] = await Promise.all([
    options?.mode ?? getExistingMode(filePath),
    fs.promises.mkdir(dirPath, { recursive: true }),
  ]);
  const tempPath = path.join(dirPath, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    // Creating the file with the mode keeps it from being more permissive than intended while it is written.
    await fs.promises.writeFile(tempPath, data, mode === undefined ? undefined : { mode });
    if (mode !== undefined) await fs.promises.chmod(tempPath, mode);
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true });
    throw error;
  }
}

async function getExistingMode(filePath: string): Promise<number | undefined> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.mode & 0o7777;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
