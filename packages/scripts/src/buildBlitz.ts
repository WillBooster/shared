import child_process from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const rootDirPath = path.resolve();

function buildIfNeeded(): void {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));

  const cacheDirPath = path.resolve(rootDirPath, 'node_modules', '.cache', 'build');
  const cacheFilePath = path.resolve(cacheDirPath, 'last-test-build');
  fs.mkdirSync(cacheDirPath, { recursive: true });

  const commitHash = child_process.execSync('git rev-parse HEAD').toString().trim();
  const filteredEnv: Record<string, string | undefined> = {};
  const targetKeys = ['APP_ENV', 'NODE_ENV'];
  for (const [key, value] of Object.entries(process.env).sort(([key1], [key2]) => key1.localeCompare(key2))) {
    if (key.startsWith('BLITZ_PUBLIC_') || targetKeys.includes(key)) {
      filteredEnv[key] = value;
    }
  }
  const filteredEnvJson = JSON.stringify(filteredEnv);
  delete (packageJson as any).scripts;

  const diff = child_process
    .execSync('git diff *.config.* app db integrations mailers public', {
      cwd: rootDirPath,
    })
    .toString()
    .trim();
  const content = commitHash + filteredEnvJson + diff + JSON.stringify(packageJson);

  const hash = createHash('sha256');
  hash.update(content);
  const contentHash = hash.digest('hex');

  if (
    fs.existsSync(path.resolve(rootDirPath, '.next', 'BUILD_ID')) &&
    fs.existsSync(cacheFilePath) &&
    fs.readFileSync(cacheFilePath).toString() === contentHash
  ) {
    console.log('Skip to build production code.');
    return;
  }

  console.log('Start building production code.');
  child_process.spawnSync('yarn', ['blitz', 'build'], {
    cwd: rootDirPath,
    stdio: 'inherit',
  });
  console.log('Finished building production code.');

  fs.writeFileSync(cacheFilePath, contentHash);
}

buildIfNeeded();
