import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export async function calculateHashFromFiles(...paths: string[]): Promise<string> {
  const hash = crypto.createHash('sha512');
  for (const fileOrDirPath of paths.sort()) {
    const stat = await fs.promises.stat(fileOrDirPath);
    if (stat.isDirectory()) {
      // Get all files in the directory
      const dirents = await fs.promises.readdir(fileOrDirPath, { withFileTypes: true, recursive: true });
      for (const dirent of dirents.sort((d1, d2) => d1.name.localeCompare(d2.name))) {
        if (dirent.isFile()) {
          hash.update(await fs.promises.readFile(path.join(fileOrDirPath, dirent.name), 'utf8'));
        }
      }
    } else if (stat.isFile()) {
      hash.update(await fs.promises.readFile(fileOrDirPath, 'utf8'));
    }
  }
  return hash.digest('hex');
}

export async function updateHashFromFiles(hashFilePath: string, ...paths: string[]): Promise<boolean> {
  let oldHash = '';
  try {
    oldHash = await fs.promises.readFile(hashFilePath, 'utf8');
  } catch {
    // do nothing
  }
  const newHash = await calculateHashFromFiles(...paths);
  if (oldHash === newHash) return false;

  await fs.promises.writeFile(hashFilePath, newHash, 'utf8');
  return true;
}
