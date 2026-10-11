import fs from 'node:fs';
import path from 'node:path';

import scopedPackage from './package.json' with { type: 'json' };

export const unscopedPackageDir = '.tmp/unscoped-release';

export function verifyConditions(_config, { cwd }) {
  // The following npm publisher reads pkgRoot during verification, before prepare runs.
  // Keep this plugin before that publisher in release.config.mjs.
  writeUnscopedPackage(cwd, '0.0.0');
}

export function prepare(_config, { cwd, nextRelease }) {
  writeUnscopedPackage(cwd, nextRelease.version);
}

// npm scans every new version before releasing it, usually within minutes, and may hold one for review or
// block it while `npm publish` has already succeeded. Publishing the unscoped wrapper before its scoped
// dependency is installable would leave `wbfy@latest` uninstallable, and a version that never appears must
// fail the release instead of passing unnoticed. release.config.mjs runs it after the scoped package's npm and GitHub publishers.
const scopedVersionTimeoutMs = 60 * 60 * 1000;
const scopedVersionPollIntervalMs = 30 * 1000;

export async function publish(_config, { nextRelease, logger }) {
  const { name, publishConfig } = scopedPackage;
  const url = new URL(`${name.replace('/', '%2f')}/${nextRelease.version}`, publishConfig.registry);
  const deadline = Date.now() + scopedVersionTimeoutMs;
  while (!(await isInstallable(url))) {
    if (Date.now() >= deadline) {
      throw new Error(
        `${name}@${nextRelease.version} is not installable from ${publishConfig.registry} after ${scopedVersionTimeoutMs / 60_000} minutes; npm may be holding it for review. The unscoped wbfy skips this version, so wbfy@latest stays on the previous release.`
      );
    }
    logger.log(`Waiting for npm to make ${name}@${nextRelease.version} installable`);
    await new Promise((resolve) => setTimeout(resolve, scopedVersionPollIntervalMs));
  }
}

async function isInstallable(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    // A transient network failure is retried like a version npm has not released yet.
    return false;
  }
}

function writeUnscopedPackage(cwd, version) {
  const { name, description, repository, license, author, engines, publishConfig } = scopedPackage;
  const dirPath = path.join(cwd, unscopedPackageDir);
  fs.mkdirSync(path.join(dirPath, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(dirPath, 'package.json'),
    `${JSON.stringify(
      {
        name: 'wbfy',
        version,
        description,
        repository,
        license,
        author,
        type: 'module',
        bin: { wbfy: 'bin/wbfy.js' },
        files: ['bin/', 'NOTICE'],
        dependencies: { [name]: version },
        engines,
        publishConfig,
      },
      undefined,
      2
    )}\n`
  );
  fs.writeFileSync(path.join(dirPath, 'bin/wbfy.js'), `#!/usr/bin/env bun\n\nimport '${name}/bin/wbfy.js';\n`);
  fs.chmodSync(path.join(dirPath, 'bin/wbfy.js'), 0o755);
  for (const fileName of ['README.md', 'LICENSE', 'NOTICE']) {
    fs.copyFileSync(path.join(cwd, fileName), path.join(dirPath, fileName));
  }
}
