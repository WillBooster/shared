import path from 'node:path';

import { globIgnore } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import fg from 'fast-glob';
import type { ArgumentsCamelCase, Argv, CommandModule, InferredOptionTypes } from 'yargs';

import { findSelfProject, type Project } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { runPackageCommand } from '../utils/packageCommand.js';

const argumentsBuilder = {
  files: { type: 'string', array: true, default: [] as string[], describe: 'Slidev deck files to check' },
} as const;

const builder = {
  fix: { type: 'boolean', default: false, describe: 'Apply fixes suggested by slidev-check' },
} as const;

type SlidevCheckOptions = InferredOptionTypes<typeof argumentsBuilder & typeof builder & typeof sharedOptionsBuilder>;
type SlidevCheckArgv = ArgumentsCamelCase<SlidevCheckOptions>;

export const slidevCheckCommand: CommandModule<unknown, SlidevCheckOptions> = {
  command: 'slidev-check [files..]',
  describe: 'Check selected Slidev decks, or all *.slidev.md decks when no files are given',
  builder: (yargs: Argv<unknown>) =>
    yargs.options(builder).positional('files', argumentsBuilder.files) as Argv<SlidevCheckOptions>,
  async handler(argv) {
    const project = findSelfProject(argv, false);
    if (!project) {
      console.error(chalk.red('No project found.'));
      process.exitCode = 1;
      return;
    }
    const deckPaths = argv.files.length > 0 ? argv.files.map((file) => path.resolve(file)) : findSlidevDecks(project);
    if (deckPaths.length === 0) {
      console.info('No Slidev decks found.');
      return;
    }
    process.exitCode = await checkSlidevDecks(project, deckPaths, argv);
  },
};

export function findSlidevDecks(project: Project): string[] {
  // Keep discovery identical to wbfy's dependency detection, including ignored fixture and build directories.
  return fg
    .globSync('**/*.slidev.md', { dot: true, cwd: project.dirPath, ignore: globIgnore })
    .toSorted((a, b) => a.localeCompare(b));
}

export async function checkSlidevDecks(
  project: Project,
  deckPaths: string[],
  argv: Pick<SlidevCheckArgv, 'dryRun' | 'verbose'> & { fix?: boolean }
): Promise<number> {
  for (const deckPath of deckPaths) {
    const quotedDeckPath = `'${deckPath.replaceAll("'", String.raw`'\''`)}'`;
    const command = `${project.packageManagerCommand} slidev-check ${argv.fix ? '--fix ' : ''}${quotedDeckPath}`;
    const exitCode = await runPackageCommand(command, project, argv, { allowFailure: true });
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}
