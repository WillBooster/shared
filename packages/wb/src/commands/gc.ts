import type { CommandModule, InferredOptionTypes } from 'yargs';

import { detectGcMode, runGc } from '../gc.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

export const gcCommand: CommandModule<unknown, InferredOptionTypes<typeof sharedOptionsBuilder>> = {
  command: 'gc',
  describe:
    'Remove stale temporary files, worktrees, and build artifacts: under the ghq root locally, or stale job workspaces on a CI runner.',
  handler(argv) {
    const mode = detectGcMode();
    if (mode) runGc(mode, !!argv.dryRun);
  },
};
