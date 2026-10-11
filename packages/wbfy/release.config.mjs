import { fileURLToPath } from 'node:url';

import { createBundledWorkspaceReleaseConfig } from '../../scripts/bundledWorkspaceRelease.mjs';
import { unscopedPackageDir } from './unscopedRelease.mjs';

const config = createBundledWorkspaceReleaseConfig(import.meta.url);

export default {
  ...config,
  // The wrapper's wait for npm to release @willbooster/wbfy can fail the run, and a failed publish step
  // skips every later one, so keep it and its npm publisher after @semantic-release/github.
  plugins: [
    ...config.plugins,
    fileURLToPath(new URL('unscopedRelease.mjs', import.meta.url)),
    ['@semantic-release/npm', { pkgRoot: unscopedPackageDir }],
  ],
};
