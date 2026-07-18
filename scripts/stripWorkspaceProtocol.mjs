// npm (which semantic-release's npm plugin shells out to for `npm version`/`npm publish`) cannot
// parse `workspace:` specifiers and crashes with "Cannot read properties of null (reading
// 'matches')", while Bun REQUIRES the protocol so a cold install links the workspace instead of
// shadowing it with a registry copy (skipping the workspace's own dependencies). Resolve the
// conflict by rewriting `workspace:` ranges to `*` on the CI checkout just before releasing —
// the affected manifests are private/unpublished, so nothing ships with the rewritten range.
import fs from 'node:fs';
import path from 'node:path';

const packageJsonPaths = [
  'package.json',
  ...fs
    .readdirSync('packages', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join('packages', entry.name, 'package.json'))
    .filter((packageJsonPath) => fs.existsSync(packageJsonPath)),
];
for (const packageJsonPath of packageJsonPaths) {
  const original = fs.readFileSync(packageJsonPath, 'utf8');
  const rewritten = original.replaceAll(/"workspace:[^"]*"/gu, '"*"');
  if (rewritten !== original) {
    fs.writeFileSync(packageJsonPath, rewritten);
    console.info(`Rewrote workspace: ranges in ${packageJsonPath} for npm-based release tooling.`);
  }
}
