import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isErrnoException } from './errno.js';

export interface WriteFileAtomicOptions {
  mode?: number;
}

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
  options?: WriteFileAtomicOptions
): Promise<void> {
  const dirPath = path.dirname(filePath);
  const [mode] = await Promise.all([
    options?.mode ?? getExistingMode(filePath),
    fs.promises.mkdir(dirPath, { recursive: true }),
  ]);
  const tempPath = getTempPath(dirPath);
  try {
    // Creating the file with the mode keeps it from being more permissive than intended while it is written.
    await fs.promises.writeFile(tempPath, data, mode === undefined ? undefined : { mode });
    if (mode !== undefined) await fs.promises.chmod(tempPath, mode);
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    // A cleanup failure must not replace the error that explains why the write failed.
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** The synchronous version of `writeFileAtomic`. */
export function writeFileAtomicSync(
  filePath: string,
  data: string | Uint8Array,
  options?: WriteFileAtomicOptions
): void {
  const dirPath = path.dirname(filePath);
  const mode = options?.mode ?? getExistingModeSync(filePath);
  fs.mkdirSync(dirPath, { recursive: true });
  const tempPath = getTempPath(dirPath);
  try {
    fs.writeFileSync(tempPath, data, mode === undefined ? undefined : { mode });
    if (mode !== undefined) fs.chmodSync(tempPath, mode);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // A cleanup failure must not replace the error that explains why the write failed.
    }
    throw error;
  }
}

function getTempPath(dirPath: string): string {
  // The name does not include the target's, which may already be near the file name length limit.
  return path.join(dirPath, `.${randomUUID()}.tmp`);
}

async function getExistingMode(filePath: string): Promise<number | undefined> {
  try {
    const stat = await fs.promises.stat(filePath);
    return toPermissionBits(stat);
  } catch (error) {
    return ignoreMissingFile(error);
  }
}

function getExistingModeSync(filePath: string): number | undefined {
  try {
    return toPermissionBits(fs.statSync(filePath));
  } catch (error) {
    return ignoreMissingFile(error);
  }
}

function toPermissionBits(stat: fs.Stats): number {
  // `stat`'s mode includes file-type bits, which `chmod` is not specified to accept.
  return stat.mode & 0o7777;
}

function ignoreMissingFile(error: unknown): undefined {
  if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
  throw error;
}
