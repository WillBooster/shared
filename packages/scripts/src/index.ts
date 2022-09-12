import { hideBin } from 'yargs/helpers';

import { buildIfNeeded } from './commands/buildIfNeeded';
import { optimizeDepsOnDocker } from './commands/optimizeDepsOnDocker';

// https://github.com/yargs/yargs/issues/1929#issuecomment-920391458
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yargs = require('yargs');

export async function cli(): Promise<void> {
  await yargs(hideBin(process.argv)).command(buildIfNeeded).command(optimizeDepsOnDocker).demandCommand().help().argv;
}
