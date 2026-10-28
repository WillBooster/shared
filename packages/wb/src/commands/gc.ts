import type { CommandModule, InferredOptionTypes } from 'yargs';

import { runGc } from '../gc.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { isCI } from '../utils/ci.js';

export const gcCommand: CommandModule<unknown, InferredOptionTypes<typeof sharedOptionsBuilder>> = {
  command: 'gc',
  describe:
    'Remove stale temporary files, worktrees, and build artifacts: under the ghq root locally, or stale job workspaces on a self-hosted CI runner.',
  handler(argv) {
    if (isCI(process.env.CI) && !process.env.RUNNER_WORKSPACE) {
      console.error('wb gc: skipped because RUNNER_WORKSPACE is not set on CI.');
      return;
    }
    runGc(isCI(process.env.CI) ? 'ci' : 'local', !!argv.dryRun);
  },
};
