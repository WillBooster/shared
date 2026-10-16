import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import { findDescendantProjects } from '../project.js';
import type { Project } from '../project.js';
import { runWithSpawnInParallel } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

import { buildLintCommand, buildWorkspaceIgnorePatterns } from './lint.js';

const builder = {} as const;

// Not `BUN check`: normalizeScript rewrites `BUN ` to `bun run `, which would look up a `check` script.
const bunCheckCommand = 'bun check';

type TypeCheckCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>;
export type TypeCheckCommandArgv = ArgumentsCamelCase<TypeCheckCommandOptions>;

export const typeCheckCommand: CommandModule<unknown, TypeCheckCommandOptions> = {
  command: 'typecheck',
  describe: 'Run type checking. Environment variables are not loaded.',
  builder,
  async handler(argv) {
    process.exit(await typeCheck(argv));
  },
};

export async function typeCheck(argv: TypeCheckCommandArgv): Promise<number> {
  const projects = await findDescendantProjects(argv, false);
  if (!projects) {
    console.error(chalk.red('No project found.'));
    return 1;
  }

  let removedNextDir = false as boolean;
  const promises = projects.descendants.map(async (project) => {
    const commands = buildTypeCheckCommands(project, projects.descendants);
    while (commands.length > 0) {
      const exitCode = await runWithSpawnInParallel(commands.join(' && '), project, argv, {
        ci: projects.descendants.length > 1,
        exitIfFailed: false,
        preserveColor: true,
      });

      const nextDirPath = path.join(project.dirPath, '.next');
      // Only the compiler reads Next.js's generated types; deleting the cache cannot fix an oxlint error.
      if (exitCode && commands.includes(bunCheckCommand) && fs.existsSync(nextDirPath)) {
        fs.rmSync(nextDirPath, { force: true, recursive: true });
        console.info(chalk.yellow('Removed `.next` directory. We will re-try type checking.'));
        removedNextDir = true;
        continue;
      }

      return exitCode;
    }
  });
  const exitCodes = await Promise.all(promises);
  let finalExitCode = 0;
  for (const exitCode of exitCodes) {
    if (exitCode) finalExitCode = exitCode;
  }
  if (!finalExitCode)
    console.info(
      chalk.green(
        removedNextDir
          ? '-----\nNo type errors found. Please ignore the previous type errors, as they were caused by outdated Next.js cache files.'
          : 'No type errors found.'
      )
    );
  return finalExitCode;
}

/**
 * Every type-check command this project runs, as scripts for `normalizeScript`. Exported so
 * `wb verify`'s step recap can name the same tools instead of re-deriving the conditions, which
 * would silently go stale the next time this list changes.
 */
export function buildTypeCheckCommands(project: Project, projects: Project[]): string[] {
  const commands = buildTypeScriptTypeCheckCommands(project, projects);
  if (!project.packageJson.workspaces && project.hasOwnDependency('pyright')) {
    commands.push('YARN pyright');
  }
  return commands;
}

function buildTypeScriptTypeCheckCommands(project: Project, projects: Project[]): string[] {
  if (project.packageJson.workspaces && !project.hasSourceCode) {
    // Not `bun check`: the tsconfig.json of a workspace root without sources of its own also
    // includes its workspaces' sources, which type-check only under each workspace's own compiler
    // options, and `bun check <files>` still reports errors in every file they import. Oxlint
    // reports diagnostics only for the files it visits, each under its nearest tsconfig.json, so
    // the root checks through it the files that no workspace compiles (e.g. `test/`, `scripts/`,
    // `*.config.ts`). Oxlint applies config overrides after `-A all`, so override lint errors can
    // still fail this check.
    const command = buildLintCommand(
      project,
      { fix: false, format: false, quiet: true, allowAllRules: true },
      undefined,
      buildWorkspaceIgnorePatterns(project, projects, compilesItself)
    );
    return command?.includes('--type-check') ? [command] : [];
  }
  return compilesItself(project) ? [bunCheckCommand] : [];
}

function compilesItself(project: Project): boolean {
  // `bun check` needs no `typescript` dependency, so wbfy's `typecheck` script marks the packages
  // that contain TypeScript.
  return !!project.packageJson.scripts?.typecheck;
}

export const tcCommand: CommandModule<unknown, TypeCheckCommandOptions> = {
  ...typeCheckCommand,
  command: 'tc',
};
