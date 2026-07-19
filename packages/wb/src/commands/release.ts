import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import { globby } from 'globby';
import type { PackageJson } from 'type-fest';
import type { ArgumentsCamelCase, Argv, CommandModule, InferredOptionTypes } from 'yargs';

import { treeKill } from '@willbooster/shared-lib-node/src';

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

  // Maps a mutated file to its pre-release content (raw bytes — bun.lockb is binary); `undefined`
  // marks a file that did not exist and must be deleted on restore (e.g. a created lockfile).
  const modifiedFiles = new Map<string, Buffer | undefined>();
  // With a handler installed, SIGINT/SIGTERM no longer terminate this process, so the
  // finally-restore always executes and the signal is re-raised afterwards. The handler also
  // FORWARDS the signal to the running child: children are spawned asynchronously (never
  // spawnSync, which would block the event loop and defer the handler until after the child —
  // and a publish — completed), so a signal targeted at this process alone still cancels the
  // child promptly.
  let receivedSignal: NodeJS.Signals | undefined;
  const activeChild: ActiveChildRef = { current: undefined };
  const signalHandler = (signal: NodeJS.Signals): void => {
    receivedSignal = signal;
    // treeKill (not child.kill): semantic-release and bun install spawn their own subprocesses
    // (npm publish, git push, ...), which must not keep publishing after wb reports cancellation.
    // treeKill THROWS (missing/timing-out `ps`, EPERM), and an exception escaping a signal
    // listener would terminate the process and skip the restoring finally — so degrade to
    // killing the direct child instead.
    try {
      if (activeChild.current?.pid) treeKill(activeChild.current.pid, signal);
    } catch (error) {
      console.error(chalk.red(`Failed to terminate the release child process tree: ${String(error)}`));
      activeChild.current?.kill(signal);
    }
  };
  const guardedSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of guardedSignals) process.on(signal, signalHandler);

  let exitCode = 0;
  let releaseRanSuccessfully = false;
  try {
    if (await releasePublishesToNpm(project)) {
      await prepareNpmCompatibleLayout(project, argv, modifiedFiles, activeChild);
    } else {
      // The hoisted reinstall and workspace-range rewrite exist solely so npm (which the
      // @semantic-release/npm plugin shells out to) can digest the checkout; without that plugin
      // the release runs directly on the isolated layout (issue #1000).
      console.info(
        chalk.cyan(
          'Skipping the hoisted reinstall because the semantic-release configuration does not include @semantic-release/npm.'
        )
      );
    }
    // A signal may have arrived between children (nothing to forward to at that instant), so it
    // must be checked explicitly before anything publishes.
    if (receivedSignal) {
      throw new Error(`Aborted by ${receivedSignal} before running the release.`);
    }
    exitCode = await runSemanticRelease(project, argv, activeChild);
    // Recorded separately from receivedSignal: a signal arriving AFTER a successful publish must
    // not demote the restore to byte-for-byte (that would revert the published version bumps).
    releaseRanSuccessfully = exitCode === 0;
  } catch (error) {
    // Errors must unwind through this try (never `process.exit` inside it): the restore below is
    // the only thing that undoes the bunfig/package.json mutations.
    console.error(chalk.red(String(error instanceof Error ? error.message : error)));
    exitCode = 1;
  } finally {
    // On failure or interruption, restore byte-for-byte: semantic-release may have left PARTIAL
    // edits (e.g. a version bump without a publish), which must not survive. The semantic
    // workspace-range restore is reserved for a successful release.
    const restoredFilePaths: string[] = [];
    for (const [filePath, content] of modifiedFiles) {
      if (restoreModifiedFile(filePath, content, releaseRanSuccessfully)) restoredFilePaths.push(filePath);
    }
    if (restoredFilePaths.length > 0) {
      console.info(
        chalk.cyan(`Restored ${restoredFilePaths.map((p) => path.relative(project.dirPath, p)).join(', ')}.`)
      );
    }
    // The hint applies only when the hoisted reinstall actually ran; bunfig.toml is snapshotted
    // exactly in that branch.
    const reinstalledWithHoistedLinker = [...modifiedFiles.keys()].some(
      (filePath) => path.basename(filePath) === 'bunfig.toml'
    );
    if (reinstalledWithHoistedLinker && !isCI(project.env.CI)) {
      console.info(
        chalk.yellow(
          'node_modules now uses the hoisted layout; run a clean reinstall (`rm -rf node_modules packages/*/node_modules && bun install`) to restore the isolated layout.'
        )
      );
    }
    for (const signal of guardedSignals) process.off(signal, signalHandler);
  }
  if (receivedSignal) {
    process.kill(process.pid, receivedSignal);
    return;
  }
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

interface ActiveChildRef {
  current: child_process.ChildProcess | undefined;
}

/**
 * Spawn asynchronously and await the exit status. The event loop stays free, so parent-only
 * signals are handled promptly and forwarded to the child by release()'s signal handler.
 */
async function spawnAndWait(
  activeChild: ActiveChildRef,
  command: string,
  args: string[],
  options: child_process.SpawnOptions
): Promise<number> {
  return await new Promise<number>((resolve) => {
    const child = child_process.spawn(command, args, options);
    activeChild.current = child;
    child.on('error', (error) => {
      activeChild.current = undefined;
      console.error(chalk.red(String(error)));
      resolve(1);
    });
    child.on('exit', (code) => {
      activeChild.current = undefined;
      resolve(code ?? 1);
    });
  });
}

/**
 * Whether the release can publish to npm. True unless a plugin list is explicitly configured
 * (in a JSON-parseable source) and omits `@semantic-release/npm` everywhere in scope — the root
 * and, for multi-semantic-release monorepos, each workspace package (a package-level plugin list
 * overrides the root's). semantic-release's DEFAULT plugin list includes the npm plugin, so a
 * missing plugin list, a non-JSON config file, or an `extends` preset conservatively keeps the
 * npm preparation.
 */
export async function releasePublishesToNpm(project: Pick<Project, 'dirPath' | 'packageJson'>): Promise<boolean> {
  const rootPlugins = readExplicitSemanticReleasePlugins(project.dirPath, project.packageJson);
  // Without an explicit root plugin list, semantic-release's default list (npm included) applies.
  if (!Array.isArray(rootPlugins) || pluginsIncludeNpm(rootPlugins)) return true;

  for (const packageDirPath of await findWorkspacePackageDirs(project)) {
    const plugins = readExplicitSemanticReleasePlugins(packageDirPath, undefined);
    // A workspace package without its own plugin list inherits the root's (npm-free) decision.
    if (plugins === 'unknown' || (Array.isArray(plugins) && pluginsIncludeNpm(plugins))) return true;
  }
  return false;
}

function pluginsIncludeNpm(plugins: readonly unknown[]): boolean {
  return plugins.some((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === '@semantic-release/npm');
}

/**
 * cosmiconfig 9's default searchPlaces order for module "release" (what semantic-release 25
 * delegates to), minus the leading package.json entry, which the caller checks first. The FIRST
 * existing place wins; places whose format JSON.parse cannot read make the effective plugin
 * list 'unknown'.
 */
const semanticReleaseConfigSearchPlaces: { fileName: string; jsonParseable: boolean }[] = [
  { fileName: '.releaserc', jsonParseable: true },
  { fileName: '.releaserc.json', jsonParseable: true },
  { fileName: '.releaserc.yaml', jsonParseable: false },
  { fileName: '.releaserc.yml', jsonParseable: false },
  { fileName: '.releaserc.js', jsonParseable: false },
  { fileName: '.releaserc.ts', jsonParseable: false },
  { fileName: '.releaserc.mjs', jsonParseable: false },
  { fileName: '.releaserc.cjs', jsonParseable: false },
  { fileName: '.config/releaserc', jsonParseable: true },
  { fileName: '.config/releaserc.json', jsonParseable: true },
  { fileName: '.config/releaserc.yaml', jsonParseable: false },
  { fileName: '.config/releaserc.yml', jsonParseable: false },
  { fileName: '.config/releaserc.js', jsonParseable: false },
  { fileName: '.config/releaserc.ts', jsonParseable: false },
  { fileName: '.config/releaserc.mjs', jsonParseable: false },
  { fileName: '.config/releaserc.cjs', jsonParseable: false },
  { fileName: 'release.config.js', jsonParseable: false },
  { fileName: 'release.config.ts', jsonParseable: false },
  { fileName: 'release.config.mjs', jsonParseable: false },
  { fileName: 'release.config.cjs', jsonParseable: false },
];

function readExplicitSemanticReleasePlugins(
  dirPath: string,
  packageJson: PackageJson | undefined
): readonly unknown[] | undefined | 'unknown' {
  // cosmiconfig searches package.json's `release` key BEFORE any rc/config file; a missing or
  // unreadable package.json just falls through to the file search places.
  if (packageJson === undefined) {
    try {
      packageJson = JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf8')) as PackageJson;
    } catch {
      packageJson = undefined;
    }
  }
  let config = (packageJson as { release?: { plugins?: unknown; extends?: unknown } } | undefined)?.release;
  if (config === undefined) {
    for (const { fileName, jsonParseable } of semanticReleaseConfigSearchPlaces) {
      const configPath = path.join(dirPath, fileName);
      if (!fs.existsSync(configPath)) continue;
      if (!jsonParseable) return 'unknown';
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as typeof config;
      } catch {
        return 'unknown';
      }
      break;
    }
  }
  if (!config || typeof config !== 'object') return undefined;
  if (Array.isArray(config.plugins)) return config.plugins;
  // An `extends` preset may contribute its own plugin list, which cannot be resolved statically.
  return config.extends === undefined ? undefined : 'unknown';
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
  modifiedFiles: Map<string, Buffer | undefined>,
  activeChild: ActiveChildRef
): Promise<void> {
  const bunfigPath = path.join(project.dirPath, 'bunfig.toml');
  const bunfig = fs.existsSync(bunfigPath) ? fs.readFileSync(bunfigPath, 'utf8') : undefined;
  const hoistedBunfig = bunfig === undefined ? undefined : buildHoistedBunfig(bunfig);
  if (bunfig !== undefined && hoistedBunfig !== bunfig) {
    console.info(chalk.cyan('Clean-reinstalling with the hoisted linker so npm can walk node_modules...'));
    if (!argv.dryRun) {
      modifiedFiles.set(bunfigPath, Buffer.from(bunfig, 'utf8'));
      // The hoisted reinstall may rewrite (or create) the lockfile; snapshot the raw bytes so a
      // successful release leaves no tracked or untracked lockfile changes behind.
      for (const lockFileName of ['bun.lock', 'bun.lockb']) {
        const lockFilePath = path.join(project.dirPath, lockFileName);
        modifiedFiles.set(lockFilePath, fs.existsSync(lockFilePath) ? fs.readFileSync(lockFilePath) : undefined);
      }
      fs.writeFileSync(bunfigPath, hoistedBunfig ?? '', 'utf8');
      const nodeModulesDirPaths = [project.dirPath, ...(await findWorkspacePackageDirs(project))].map((dirPath) =>
        path.join(dirPath, 'node_modules')
      );
      for (const nodeModulesDirPath of nodeModulesDirPaths) {
        fs.rmSync(nodeModulesDirPath, { force: true, recursive: true });
      }
      // Resolve and download with lifecycle scripts DISABLED while the release credentials
      // (VERDACCIO_TOKEN, NPM_TOKEN, GITHUB_TOKEN, FNOX_AGE_KEY, ...) are in the environment,
      // so repository- or dependency-defined preinstall/postinstall can never read them —
      // mirroring reusable-workflows' two-step release install (issue #1003).
      const installStatus = await spawnAndWait(activeChild, 'bun', ['install', '--ignore-scripts'], {
        cwd: project.dirPath,
        env: project.env,
        stdio: 'inherit',
      });
      if (installStatus !== 0) {
        // Throwing (instead of process.exit, which would skip the caller's finally) lets the
        // restore run before the process terminates.
        throw new Error('bun install failed while preparing the release.');
      }
      // Replay the skipped lifecycle scripts in a credential-scrubbed environment. A repeated
      // `bun install` is a no-op that does not replay them, so node_modules is wiped again;
      // every package is already in bun's cache from the credentialed step, so this re-link
      // needs no registry credentials.
      for (const nodeModulesDirPath of nodeModulesDirPaths) {
        fs.rmSync(nodeModulesDirPath, { force: true, recursive: true });
      }
      const replayStatus = await spawnAndWait(activeChild, 'bun', ['install'], {
        cwd: project.dirPath,
        env: buildCredentialFreeEnv(project.env),
        stdio: 'inherit',
      });
      if (replayStatus !== 0) {
        throw new Error('bun install failed while replaying lifecycle scripts for the release.');
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
    // Snapshot EVERY manifest (not only rewritten ones): semantic-release also edits manifests
    // without workspace: ranges (version bumps), and a failed release must restore those too.
    if (!argv.dryRun) {
      modifiedFiles.set(packageJsonPath, Buffer.from(original, 'utf8'));
    }
    const rewritten = rewriteWorkspaceRanges(original);
    if (rewritten === original) continue;

    console.info(chalk.cyan(`Rewriting workspace: ranges in ${path.relative(project.dirPath, packageJsonPath)}...`));
    if (!argv.dryRun) {
      fs.writeFileSync(packageJsonPath, rewritten, 'utf8');
    }
  }
}

// The credentials the release workflow injects (cf. reusable-workflows' release.yml secrets and
// npm's own token variables). The release command loads the project with loadEnv: false, so no
// wb-loader-injected keys exist to scrub beyond these. A denylist (not an allowlist) is
// deliberate: in the supported entry point — reusable-workflows' release job — these enumerated
// variables are the ONLY secrets in the ambient environment (fnox secrets stay encrypted because
// FNOX_AGE_KEY is scrubbed and never exported as plaintext there), while an allowlist would
// break lifecycle scripts that legitimately read operational variables (PATH, HOME, CI, ...).
// A local `wb release` inherits whatever the developer's shell already exposes to every
// `bun install`, which this replay does not widen.
const credentialEnvVarNames = [
  'VERDACCIO_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_PACKAGES_TOKEN',
  'GH_PKG_READ_TOKEN',
  'FNOX_AGE_KEY',
];

/**
 * A copy of `env` safe to expose to dependency lifecycle scripts. Credential variables are
 * EMPTIED rather than deleted so `${VERDACCIO_TOKEN}`-style references in .npmrc keep expanding
 * to '' instead of crashing the install (the pattern reusable-workflows relies on).
 */
export function buildCredentialFreeEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const scrubbedEnv = { ...env };
  for (const name of credentialEnvVarNames) {
    if (name in scrubbedEnv) scrubbedEnv[name] = '';
  }
  return scrubbedEnv;
}

/**
 * Undo the temporary release-time mutations of one file. `package.json` files are restored
 * semantically instead of byte-for-byte: semantic-release's npm plugin writes the released
 * version into manifests while they hold the rewritten ranges, and a byte restore would silently
 * revert that bump — so when the file changed during the release, only the `workspace:`
 * specifiers are written back into the CURRENT content.
 */
/** Returns whether the on-disk content actually changed (drives the "Restored ..." message). */
function restoreModifiedFile(
  filePath: string,
  originalContent: Buffer | undefined,
  releaseSucceeded: boolean
): boolean {
  if (originalContent === undefined) {
    const existed = fs.existsSync(filePath);
    fs.rmSync(filePath, { force: true });
    return existed;
  }
  if (releaseSucceeded && path.basename(filePath) === 'package.json' && fs.existsSync(filePath)) {
    const currentContent = fs.readFileSync(filePath, 'utf8');
    const originalText = originalContent.toString('utf8');
    if (currentContent !== rewriteWorkspaceRanges(originalText)) {
      const restoredContent = restoreWorkspaceRanges(currentContent, originalText);
      if (restoredContent === currentContent) return false;
      fs.writeFileSync(filePath, restoredContent, 'utf8');
      return true;
    }
  }
  const currentBuffer = fs.existsSync(filePath) ? fs.readFileSync(filePath) : undefined;
  if (currentBuffer?.equals(originalContent)) return false;
  // Write the snapshot bytes verbatim: bun.lockb is binary, so any text decode/encode round trip
  // would corrupt it.
  fs.writeFileSync(filePath, originalContent);
  return true;
}

export function buildHoistedBunfig(bunfig: string): string {
  return bunfig
    .replace(/^(\s*linker\s*=\s*)["']isolated["']/mu, '$1"hoisted"')
    .replace(/^\s*globalStore\s*=\s*true[^\n]*\n?/mu, '');
}

export function rewriteWorkspaceRanges(packageJsonContent: string): string {
  // Operate only inside the dependency sections: a blanket `"workspace:..."` replacement would
  // also corrupt unrelated string values (e.g. a description starting with `workspace:`), and a
  // name-keyed global replacement would touch same-named keys in other sections (e.g. overrides).
  return replaceInDependencySections(packageJsonContent, (section) =>
    section.replaceAll(/("[^"\n]+"\s*:\s*)"workspace:[^"]*"/gu, '$1"*"')
  );
}

/**
 * Re-apply the original `workspace:` specifiers to the CURRENT manifest content. Matching keys
 * off the dependency NAME (not the `"*"` placeholder) is deliberate: multi-semantic-release's
 * prepare step overwrites local dependency specifiers with concrete released versions, and the
 * committed manifest must get its `workspace:` protocol back regardless — Bun requires the
 * protocol so a cold install links the workspace instead of resolving a registry copy.
 */
export function restoreWorkspaceRanges(currentContent: string, originalContent: string): string {
  const workspaceDependencies = collectWorkspaceDependencies(originalContent);
  // Restore per (section, name): a same-named dependency in another section may legitimately
  // hold a non-workspace range (e.g. a peerDependencies `>=1.0.0` next to a devDependencies
  // `workspace:*`) or a different workspace range, and must keep its own value.
  return replaceInDependencySections(currentContent, (section, sectionKey) => {
    let result = section;
    for (const { section: dependencySection, name, specifier } of workspaceDependencies) {
      if (dependencySection !== sectionKey) continue;
      result = result.replaceAll(
        new RegExp(`("${escapeRegExp(name)}"\\s*:\\s*)"[^"]*"`, 'gu'),
        // A replacer function, not a replacement string: specifiers containing `$` must be
        // inserted literally instead of being interpreted as substitution patterns.
        (_match, prefix: string) => `${prefix}${JSON.stringify(specifier)}`
      );
    }
    return result;
  });
}

/** Dependency sections contain only `"name": "specifier"` string pairs, so `[^{}]*` spans them. */
function replaceInDependencySections(
  content: string,
  replaceSection: (section: string, sectionKey: string) => string
): string {
  return content.replaceAll(
    /("(dependencies|devDependencies|optionalDependencies|peerDependencies)"\s*:\s*\{)([^{}]*)(\})/gu,
    (_match, prefix: string, sectionKey: string, body: string, suffix: string) =>
      `${prefix}${replaceSection(body, sectionKey)}${suffix}`
  );
}

function collectWorkspaceDependencies(
  packageJsonContent: string
): { section: string; name: string; specifier: string }[] {
  let packageJson: PackageJson;
  try {
    packageJson = JSON.parse(packageJsonContent) as PackageJson;
  } catch {
    return [];
  }
  const dependencies: { section: string; name: string; specifier: string }[] = [];
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    for (const [name, value] of Object.entries(packageJson[key] ?? {})) {
      if (typeof value === 'string' && value.startsWith('workspace:')) {
        dependencies.push({ section: key, name, specifier: value });
      }
    }
  }
  return dependencies;
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}

async function runSemanticRelease(project: Project, argv: ReleaseArgv, activeChild: ActiveChildRef): Promise<number> {
  const forwardedArgs = [...(argv.args ?? []), ...(argv['--'] ?? [])].map(String);
  // The PACKAGE name (for `bunx`/`yarn dlx`, which fetch a package) and the BIN name (for the
  // local node_modules/.bin lookup) differ for the scoped forks: `bunx multi-semantic-release`
  // would fetch the unrelated unscoped npm package instead of e.g. @anolilab's fork.
  const releasePackageName = (
    ['@anolilab/multi-semantic-release', 'multi-semantic-release', '@qiwi/multi-semantic-release'] as const
  ).find((packageName) => project.packageJson.devDependencies?.[packageName]);
  const releaseBin = releasePackageName ? 'multi-semantic-release' : 'semantic-release';

  // The project is loaded with loadEnv: false (semantic-release runs with the ambient/CI
  // environment by design), so project.env aliases process.env here; using it keeps the
  // project.env convention and picks up env loading if that design ever changes.
  const env = { ...project.env };
  prependNodeModulesBinToPath(project.dirPath, env);
  const hasLocalBin = fs.existsSync(path.join(project.dirPath, 'node_modules', '.bin', releaseBin));
  const fallbackPackageName = releasePackageName ?? 'semantic-release';
  const command = hasLocalBin
    ? [releaseBin, ...forwardedArgs]
    : project.packageManagerCommand === 'bun'
      ? ['bunx', fallbackPackageName, ...forwardedArgs]
      : ['yarn', 'dlx', fallbackPackageName, ...forwardedArgs];
  console.info(chalk.cyan(`Running: ${command.join(' ')}`));
  if (argv.dryRun) return 0;

  return await spawnAndWait(activeChild, command[0]!, command.slice(1), {
    cwd: project.dirPath,
    env,
    stdio: 'inherit',
  });
}

async function findWorkspacePackageDirs(project: Pick<Project, 'dirPath' | 'packageJson'>): Promise<string[]> {
  const workspaces = project.packageJson.workspaces;
  const patterns = Array.isArray(workspaces) ? workspaces : (workspaces?.packages ?? []);
  if (patterns.length === 0) return [];

  const dirPaths = await globby(patterns, { cwd: project.dirPath, onlyDirectories: true });
  return dirPaths.map((dirPath) => path.join(project.dirPath, dirPath));
}
