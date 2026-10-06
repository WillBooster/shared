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
        files: ['bin/'],
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
  for (const fileName of ['README.md', 'LICENSE']) {
    fs.copyFileSync(path.join(cwd, fileName), path.join(dirPath, fileName));
  }
}
