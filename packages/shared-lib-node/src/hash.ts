import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Check whether seed command can be skipped or not and update hash file if needed.
 * Note that process.env.ALLOW_TO_SKIP_SEED should be set to non-zero number or 'true' to skip seed.
 * @param hashFilePath Path to the hash file.
 * @param paths Paths to the files or directories.
 * @returns Whether seed command can be skipped.
 */
export async function canSkipSeed(hashFilePath: string, ...paths: string[]): Promise<boolean> {
  return (
    (!!Number(process.env.ALLOW_TO_SKIP_SEED) || (process.env.ALLOW_TO_SKIP_SEED ?? '').toLowerCase() === 'true') &&
    !(await updateHashFromFiles(hashFilePath, ...paths))
  );
}

/**
 * Update hash file if the hash is different from the current one.
 * @param hashFilePath Path to the hash file.
 * @param paths Paths to the files or directories.
 * @returns Whether the hash file was updated.
 */
export async function updateHashFromFiles(hashFilePath: string, ...paths: string[]): Promise<boolean> {
  let oldHash = '';
  try {
    oldHash = await fs.promises.readFile(hashFilePath, 'utf8');
  } catch {
    // do nothing
  }
  const newHash = await calculateHashFromFiles(...paths);
  if (oldHash === newHash) return false;

  await fs.promises.mkdir(path.dirname(hashFilePath), { recursive: true });
  await fs.promises.writeFile(hashFilePath, newHash, 'utf8');
  return true;
}

/**
 * Calculate hash from files.
 * @param paths Paths to the files or directories.
 * @returns Hash string.
 */
export async function calculateHashFromFiles(...paths: string[]): Promise<string> {
  const hash = crypto.createHash('sha512');
  for (const fileOrDirPath of paths.sort()) {
    const stat = await fs.promises.stat(fileOrDirPath);
    if (stat.isDirectory()) {
      // Get all files in the directory recursively
      const dirents = await fs.promises.readdir(fileOrDirPath, { withFileTypes: true, recursive: true });
      for (const dirent of dirents.sort((d1, d2) => d1.name.localeCompare(d2.name))) {
        if (dirent.isFile()) {
          // Use parentPath property which is available in Node.js 18.17.0 or later
          hash.update(
            await fs.promises.readFile(
              path.join((dirent as unknown as Record<'parentPath', string>).parentPath, dirent.name),
              'utf8'
            )
          );
        }
      }
    } else if (stat.isFile()) {
      hash.update(await fs.promises.readFile(fileOrDirPath, 'utf8'));
    }
  }
  return hash.digest('hex');
}
