// Makes the CI checkout digestible for npm, which semantic-release's npm plugin shells out to
// for `npm version`/`npm publish`:
// 1. npm cannot parse `workspace:` specifiers (crashing with "Cannot read properties of null
//    (reading 'matches')"), while Bun REQUIRES the protocol so a cold install links the workspace
//    instead of shadowing it with a registry copy — so rewrite the ranges to `*` here; the
//    affected manifests are private/unpublished, so nothing ships with the rewritten range.
// 2. npm's arborist cannot walk Bun's ISOLATED node_modules layout (the `.bun` symlink farm;
//    crashing with "Cannot read properties of null (reading 'isDescendantOf')"), so reinstall
//    with the hoisted linker for the release job only. Verified: `npm version` and
//    `npm publish --dry-run` succeed on the hoisted layout and crash on the isolated one.
// Both mutations stay on the CI checkout; nothing is committed.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Order matters: reinstall FIRST while the `workspace:` ranges are still intact (so Bun links
// the workspaces and the prepare hook can build the local wb), THEN rewrite the manifests —
// npm only needs the manifest TEXT to be parseable; node_modules stays as Bun built it.
const bunfigPath = 'bunfig.toml';
const bunfig = fs.readFileSync(bunfigPath, 'utf8');
const hoistedBunfig = bunfig
  .replace('linker = "isolated"', 'linker = "hoisted"')
  .replace(/^globalStore = true\n/mu, '');
if (hoistedBunfig !== bunfig) {
  fs.writeFileSync(bunfigPath, hoistedBunfig);
  console.info('Clean-reinstalling with the hoisted linker so npm can walk node_modules...');
  // A non-clean linker switch leaves stale global-store symlinks behind (semantic-release then
  // resolves from ~/.bun/install/cache/links, where cosmiconfig's phantom `env-paths` dependency
  // is unreachable), so wipe every node_modules first — the same clean-reinstall rule the
  // isolated-install migration documents.
  fs.rmSync('node_modules', { force: true, recursive: true });
  for (const entry of fs.readdirSync('packages', { withFileTypes: true })) {
    if (entry.isDirectory()) {
      fs.rmSync(path.join('packages', entry.name, 'node_modules'), { force: true, recursive: true });
    }
  }
  execSync('bun install', { stdio: 'inherit' });
}

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
