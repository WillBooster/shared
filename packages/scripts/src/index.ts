import { hideBin } from 'yargs/helpers';

import { buildIfNeeded } from './commands/buildIfNeeded';
import { optimizeForDockerBuild } from './commands/optimizeForDockerBuild';

// https://github.com/yargs/yargs/issues/1929#issuecomment-920391458
// eslint-disable-next-line @typescript-eslint/no-var-requires, unicorn/prefer-module
const yargs = require('yargs');

export async function cli(): Promise<void> {
  await yargs(hideBin(process.argv)).command(buildIfNeeded).command(optimizeForDockerBuild).demandCommand().help().argv;
}
