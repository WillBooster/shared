import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import { globby } from 'globby';
import type { ArgumentsCamelCase, Argv, CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import { findRootAndSelfProjects } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { prependNodeModulesBinToPath } from '../utils/binPath.js';
import { isCI } from '../utils/ci.js';

type ReleaseArgv = Partial<ArgumentsCamelCase<InferredOptionTypes<typeof sharedOptionsBuilder>>> & {
  args?: unknown[];
  '--'?: unknown[];
};

export const releaseCommand: CommandModule = {
  command: 'release [args..]',
  describe:
    'Run semantic-release (or multi-semantic-release) so that repositories using Bun isolated installs can publish to npm: ' +
    "reinstall with the hoisted linker (npm cannot walk Bun's isolated node_modules layout), " +
    'rewrite `workspace:` ranges npm cannot parse, run the release, then restore the modified files. ' +
    'Extra arguments (e.g. `--debug`, after `--`) are forwarded to the release command.',
  builder: (yargs: Argv<unknown>) => yargs.parserConfiguration({ 'populate--': true }),
  async handler(argv) {
    await release(argv as ReleaseArgv);
  },
};

export async function release(argv: ReleaseArgv, projectPathForTesting?: string): Promise<void> {
  const projects = findRootAndSelfProjects(argv, false, projectPathForTesting);
  if (!projects) {
    console.error(chalk.red('No project found.'));
    process.exit(1);
  }
  // semantic-release must run at the repository root: it reads the git repo and, for monorepos,
  // multi-semantic-release walks the workspaces itself.
  const project = projects.root;

  const modifiedFiles = new Map<string, string>();
  let exitCode = 0;
  try {
    await prepareNpmCompatibleLayout(project, argv, modifiedFiles);
    exitCode = runSemanticRelease(project, argv);
  } finally {
    for (const [filePath, content] of modifiedFiles) {
      fs.writeFileSync(filePath, content, 'utf8');
    }
    if (modifiedFiles.size > 0) {
      console.info(
        chalk.cyan(`Restored ${[...modifiedFiles.keys()].map((p) => path.relative(project.dirPath, p)).join(', ')}.`)
      );
      if (!isCI(process.env.CI)) {
        console.info(
          chalk.yellow(
            'node_modules now uses the hoisted layout; run a clean reinstall (`rm -rf node_modules packages/*/node_modules && bun install`) to restore the isolated layout.'
          )
        );
      }
    }
  }
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

/**
 * Make the checkout digestible for npm, which semantic-release's npm plugin shells out to for
 * `npm version` / `npm publish`:
 * 1. npm's arborist cannot walk Bun's ISOLATED node_modules layout (the `.bun` symlink farm), so
 *    clean-reinstall with the hoisted linker first. A non-clean linker switch would leave stale
 *    global-store symlinks behind (packages then resolve from ~/.bun/install/cache/links where
 *    phantom dependencies are unreachable), so every node_modules directory is wiped first.
 * 2. npm cannot parse `workspace:` specifiers, while Bun REQUIRES the protocol so a cold install
 *    links the workspace — so rewrite the ranges to `*` AFTER the reinstall (Bun must still see
 *    the protocol while installing; npm only needs the manifest TEXT to be parseable). The
 *    affected manifests are private/unpublished or rewritten by the npm plugin on publish.
 * All mutations are restored by the caller after the release.
 */
async function prepareNpmCompatibleLayout(
  project: Project,
  argv: ReleaseArgv,
  modifiedFiles: Map<string, string>
): Promise<void> {
  const bunfigPath = path.join(project.dirPath, 'bunfig.toml');
  const bunfig = fs.existsSync(bunfigPath) ? fs.readFileSync(bunfigPath, 'utf8') : undefined;
  const hoistedBunfig = bunfig === undefined ? undefined : buildHoistedBunfig(bunfig);
  if (bunfig !== undefined && hoistedBunfig !== bunfig) {
    console.info(chalk.cyan('Clean-reinstalling with the hoisted linker so npm can walk node_modules...'));
    if (!argv.dryRun) {
      modifiedFiles.set(bunfigPath, bunfig);
      fs.writeFileSync(bunfigPath, hoistedBunfig ?? '', 'utf8');
      for (const packageDirPath of [project.dirPath, ...(await findWorkspacePackageDirs(project))]) {
        fs.rmSync(path.join(packageDirPath, 'node_modules'), { force: true, recursive: true });
      }
      const ret = child_process.spawnSync('bun', ['install'], { cwd: project.dirPath, stdio: 'inherit' });
      if (ret.status !== 0) {
        console.error(chalk.red('bun install failed while preparing the release.'));
        process.exit(ret.status ?? 1);
      }
    }
  }

  const workspacePackageDirs = await findWorkspacePackageDirs(project);
  for (const packageJsonPath of [
    project.packageJsonPath,
    ...workspacePackageDirs.map((dirPath) => path.join(dirPath, 'package.json')),
  ]) {
    if (!fs.existsSync(packageJsonPath)) continue;

    const original = fs.readFileSync(packageJsonPath, 'utf8');
    const rewritten = rewriteWorkspaceRanges(original);
    if (rewritten === original) continue;

    console.info(chalk.cyan(`Rewriting workspace: ranges in ${path.relative(project.dirPath, packageJsonPath)}...`));
    if (!argv.dryRun) {
      modifiedFiles.set(packageJsonPath, original);
      fs.writeFileSync(packageJsonPath, rewritten, 'utf8');
    }
  }
}

export function buildHoistedBunfig(bunfig: string): string {
  return bunfig
    .replace(/^(\s*linker\s*=\s*)["']isolated["']/mu, '$1"hoisted"')
    .replace(/^\s*globalStore\s*=\s*true[^\n]*\n?/mu, '');
}

export function rewriteWorkspaceRanges(packageJsonContent: string): string {
  return packageJsonContent.replaceAll(/"workspace:[^"]*"/gu, '"*"');
}

function runSemanticRelease(project: Project, argv: ReleaseArgv): number {
  const forwardedArgs = [...(argv.args ?? []), ...(argv['--'] ?? [])].map(String);
  const releaseBin =
    project.packageJson.devDependencies?.['@anolilab/multi-semantic-release'] ||
    project.packageJson.devDependencies?.['multi-semantic-release'] ||
    project.packageJson.devDependencies?.['@qiwi/multi-semantic-release']
      ? 'multi-semantic-release'
      : 'semantic-release';

  const env = { ...process.env };
  prependNodeModulesBinToPath(project.dirPath, env);
  const hasLocalBin = fs.existsSync(path.join(project.dirPath, 'node_modules', '.bin', releaseBin));
  const command = hasLocalBin
    ? [releaseBin, ...forwardedArgs]
    : project.packageManagerCommand === 'bun'
      ? ['bunx', releaseBin, ...forwardedArgs]
      : ['yarn', 'dlx', releaseBin, ...forwardedArgs];
  console.info(chalk.cyan(`Running: ${command.join(' ')}`));
  if (argv.dryRun) return 0;

  const ret = child_process.spawnSync(command[0]!, command.slice(1), {
    cwd: project.dirPath,
    env,
    stdio: 'inherit',
  });
  return ret.status ?? 1;
}

async function findWorkspacePackageDirs(project: Project): Promise<string[]> {
  const workspaces = project.packageJson.workspaces;
  const patterns = Array.isArray(workspaces) ? workspaces : (workspaces?.packages ?? []);
  if (patterns.length === 0) return [];

  const dirPaths = await globby(patterns, { cwd: project.dirPath, onlyDirectories: true });
  return dirPaths.map((dirPath) => path.join(project.dirPath, dirPath));
}
