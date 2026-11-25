import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Creates a project directory inside this package, so that a `cloudflare.config.ts` written
 * there resolves the package's own `cf` dependency the way a real project resolves its own.
 */
export async function createCloudflareProjectDir(): Promise<string> {
  const parentDirPath = path.resolve(import.meta.dirname, '..', '..', '.tmp');
  await fs.mkdir(parentDirPath, { recursive: true });
  return fs.mkdtemp(path.join(parentDirPath, 'cloudflare-project-'));
}
