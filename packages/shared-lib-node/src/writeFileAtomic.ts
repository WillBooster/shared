import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Writes a file through a uniquely named temporary file in the same directory and a rename, so concurrent readers
 * see either the old or the new content, never a partial one, and concurrent writers never share a temporary file.
 * Creates missing parent directories. The data is not fsynced, so a power loss can still lose the latest write.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options?: { mode?: number }
): Promise<void> {
  const dirPath = path.dirname(filePath);
  await fs.promises.mkdir(dirPath, { recursive: true });
  const tempPath = path.join(dirPath, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(tempPath, data, options);
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true });
    throw error;
  }
}
