import { fileURLToPath } from 'node:url';

import { createBundledWorkspaceReleaseConfig } from '../../scripts/bundledWorkspaceRelease.mjs';
import { unscopedPackageDir } from './unscopedRelease.mjs';

const config = createBundledWorkspaceReleaseConfig(import.meta.url);

export default {
  ...config,
  // The unscoped wrapper goes last: its wait for npm to release @willbooster/wbfy can fail the run, and a
  // failed publish step skips every later one, including the canonical package's GitHub release.
  plugins: [
    ...config.plugins,
    fileURLToPath(new URL('unscopedRelease.mjs', import.meta.url)),
    ['@semantic-release/npm', { pkgRoot: unscopedPackageDir }],
  ],
};
