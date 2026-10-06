import { fileURLToPath } from 'node:url';

import { createBundledWorkspaceReleaseConfig } from '../../scripts/bundledWorkspaceRelease.mjs';
import { unscopedPackageDir } from './unscopedRelease.mjs';

const config = createBundledWorkspaceReleaseConfig(import.meta.url);

export default {
  ...config,
  plugins: config.plugins.flatMap((plugin) =>
    plugin === '@semantic-release/npm'
      ? [
          plugin,
          fileURLToPath(new URL('unscopedRelease.mjs', import.meta.url)),
          ['@semantic-release/npm', { pkgRoot: unscopedPackageDir }],
        ]
      : [plugin]
  ),
};
