import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { findRootAndSelfProjects } from '../project.js';
import type { PrivateRegistryAuth } from '../utils/privateRegistry.js';
import {
  PRIVATE_REGISTRY_SCOPE,
  downloadAndExtractRegistryPackage,
  isPrivateGitDependency,
  isPrivateRegistryDependency,
  resolvePrivateRegistryAuth,
} from '../utils/privateRegistry.js';

interface PrivatePackage {
  name: string;
  kind: 'git' | 'registry';
  /** Undefined for registry packages, which are downloaded instead of copied. */
  sourceDirPath: string | undefined;
  targetDirPath: string;
  versionSpecifier: string | undefined;
}

const dependencyKeys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

const builder = {
  'out-dir': {
    description: 'Directory to copy private packages into',
    type: 'string',
    default: '@willbooster',
  },
} as const;

export const setupPrivatePackagesCommand: CommandModule<{ dryRun?: boolean }, InferredOptionTypes<typeof builder>> = {
  command: 'setup-private-packages',
  describe:
    'Materialize private dependencies for Docker builds: copy git dependencies and download @willbooster-private/* registry packages (auth via .npmrc / ~/.npmrc locally, or VERDACCIO_TOKEN on CI)',
  builder,
  async handler(argv) {
    const projects = findRootAndSelfProjects(argv, false);
    if (!projects) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    const outDirPath = path.resolve(projects.root.dirPath, argv.outDir);
    assertSubdirectory(projects.root.dirPath, outDirPath);
    // Registry packages always materialize at the repository root: `wb optimizeForDockerBuild`
    // resolves them from `<root>/@willbooster-private` regardless of `--out-dir`.
    const registryOutDirPath = path.join(projects.root.dirPath, PRIVATE_REGISTRY_SCOPE);
    if (outDirPath === registryOutDirPath) {
      // e.g. `--out-dir @willbooster-private`: the registry download step would delete the git
      // packages copied into the aliased directory moments earlier.
      console.error(chalk.red(`--out-dir must not be the ${PRIVATE_REGISTRY_SCOPE} registry output directory itself.`));
      process.exit(1);
    }
    const privatePackages = await collectPrivatePackages(
      projects.root.dirPath,
      projects.root.packageJson,
      outDirPath,
      registryOutDirPath
    );

    if (argv.dryRun) {
      printDryRunResult(outDirPath, privatePackages);
      return;
    }

    const copiedPackages = [...privatePackages.values()].filter((p) => p.kind === 'git');
    const registryPackages = [...privatePackages.values()].filter((p) => p.kind === 'registry');
    // Resolve required configuration BEFORE deleting the existing materializations, so a missing
    // registry configuration cannot destroy a previously usable output tree.
    const auth = registryPackages.length > 0 ? resolvePrivateRegistryAuth(projects.root.dirPath) : undefined;
    if (registryPackages.length > 0 && !auth) {
      console.error(
        chalk.red(
          `No registry configured for the ${PRIVATE_REGISTRY_SCOPE} scope; add "${PRIVATE_REGISTRY_SCOPE}:registry=..." to .npmrc or ~/.npmrc.`
        )
      );
      process.exit(1);
    }

    await fs.promises.rm(outDirPath, { recursive: true, force: true });
    // Both output directories always exist afterwards: Dockerfiles COPY them unconditionally,
    // and a missing source path fails the build.
    await fs.promises.mkdir(outDirPath, { recursive: true });
    for (const privatePackage of copiedPackages) {
      await copyGitPackage(projects.root.dirPath, privatePackage);
    }

    if (auth) {
      // Download into a staging directory and swap it in only after every download succeeded, so
      // a failing registry/token/extraction cannot destroy the last usable materialization.
      const stagingDirPath = path.join(projects.root.dirPath, '.tmp', 'wb-private-registry-staging');
      const toStagedPath = (targetDirPath: string): string =>
        path.join(stagingDirPath, path.relative(registryOutDirPath, targetDirPath));
      await fs.promises.rm(stagingDirPath, { recursive: true, force: true });
      await fs.promises.mkdir(stagingDirPath, { recursive: true });
      try {
        for (const privatePackage of registryPackages) {
          await downloadAndExtractRegistryPackage(
            auth,
            privatePackage.name,
            privatePackage.versionSpecifier ?? 'latest',
            toStagedPath(privatePackage.targetDirPath)
          );
          console.info(
            `Downloaded ${privatePackage.name} to ${path.relative(projects.root.dirPath, privatePackage.targetDirPath)}`
          );
          // A downloaded package may itself depend on private packages that were not visible
          // before extraction; materialize them too.
          await collectNestedPrivatePackages(
            projects.root.dirPath,
            auth,
            privatePackage,
            privatePackages,
            outDirPath,
            registryOutDirPath,
            toStagedPath
          );
        }
        await fs.promises.rm(registryOutDirPath, { recursive: true, force: true });
        await fs.promises.rename(stagingDirPath, registryOutDirPath);
      } catch (error) {
        await fs.promises.rm(stagingDirPath, { recursive: true, force: true });
        throw error;
      }
    } else {
      await fs.promises.rm(registryOutDirPath, { recursive: true, force: true });
      await fs.promises.mkdir(registryOutDirPath, { recursive: true });
    }

    await replacePrivateDependencies(projects.root.dirPath, privatePackages);
  },
};

async function collectPrivatePackages(
  rootDirPath: string,
  rootPackageJson: PackageJson,
  outDirPath: string,
  registryOutDirPath: string
): Promise<Map<string, PrivatePackage>> {
  const privatePackages = new Map<string, PrivatePackage>();
  // Start from the root package.json by design; workspace package dependencies are outside this command's target.
  const packagesToProcess = findPrivateDependencies(rootPackageJson, outDirPath, registryOutDirPath);
  const queuedPackages = new Map(packagesToProcess.map((p) => [p.name, p]));

  for (let index = 0; index < packagesToProcess.length; index++) {
    const privatePackage = packagesToProcess[index];
    if (!privatePackage) continue;
    if (privatePackages.has(privatePackage.name)) continue;

    if (privatePackage.kind === 'git') {
      privatePackage.sourceDirPath = findInstalledPackageDir(rootDirPath, privatePackage.name);
      // Nested private dependencies of an installed git package are discoverable right away;
      // registry packages are inspected after download instead (collectNestedPrivatePackages).
      for (const packageJsonPath of await findPackageJsonPaths(privatePackage.sourceDirPath)) {
        const packageJson = await readPackageJson(packageJsonPath);
        for (const nested of findPrivateDependencies(packageJson, outDirPath, registryOutDirPath)) {
          const queued = queuedPackages.get(nested.name);
          if (queued) {
            assertNoVersionConflict(queued, nested, privatePackage.name);
          } else {
            queuedPackages.set(nested.name, nested);
            packagesToProcess.push(nested);
          }
        }
      }
    }
    privatePackages.set(privatePackage.name, privatePackage);
  }

  return privatePackages;
}

async function collectNestedPrivatePackages(
  rootDirPath: string,
  auth: PrivateRegistryAuth,
  extractedPackage: PrivatePackage,
  privatePackages: Map<string, PrivatePackage>,
  outDirPath: string,
  registryOutDirPath: string,
  toStagedPath: (targetDirPath: string) => string
): Promise<void> {
  // Registry packages still live in the staging directory at this point (they are swapped into
  // place only after every download succeeded).
  const packageJsonPath = path.join(toStagedPath(extractedPackage.targetDirPath), 'package.json');
  if (!fs.existsSync(packageJsonPath)) return;

  for (const nested of findPrivateDependencies(
    await readPackageJson(packageJsonPath),
    outDirPath,
    registryOutDirPath
  )) {
    const existing = privatePackages.get(nested.name);
    if (existing) {
      // Collapsing different requested versions into one materialization would silently violate
      // the dependent's requirement, so conflicts must fail loudly.
      assertNoVersionConflict(existing, nested, extractedPackage.name);
      continue;
    }

    if (nested.kind === 'git') {
      nested.sourceDirPath = findInstalledPackageDir(rootDirPath, nested.name);
      await copyGitPackage(rootDirPath, nested);
    } else {
      await downloadAndExtractRegistryPackage(
        auth,
        nested.name,
        nested.versionSpecifier ?? 'latest',
        toStagedPath(nested.targetDirPath)
      );
      console.info(`Downloaded ${nested.name} (nested dependency) to ${nested.targetDirPath}`);
    }
    privatePackages.set(nested.name, nested);
    await collectNestedPrivatePackages(
      rootDirPath,
      auth,
      nested,
      privatePackages,
      outDirPath,
      registryOutDirPath,
      toStagedPath
    );
  }
}

async function copyGitPackage(rootDirPath: string, privatePackage: PrivatePackage): Promise<void> {
  await fs.promises.cp(privatePackage.sourceDirPath!, privatePackage.targetDirPath, {
    recursive: true,
    force: true,
    // Bun's isolated linker exposes installed packages through symlinks; the materialized tree
    // must contain real files (a copied absolute symlink would dangle inside the Docker image,
    // and later dependency rewriting would write through it into the shared store).
    dereference: true,
    filter: (src) => {
      const segments = path.relative(privatePackage.sourceDirPath!, src).split(path.sep);
      return !segments.includes('node_modules') && !segments.includes('.git');
    },
  });
  console.info(`Copied ${privatePackage.name} to ${path.relative(rootDirPath, privatePackage.targetDirPath)}`);
}

function assertNoVersionConflict(existing: PrivatePackage, requested: PrivatePackage, dependentName: string): void {
  if (existing.kind === requested.kind && existing.versionSpecifier === requested.versionSpecifier) return;

  throw new Error(
    `Conflicting requirements for ${existing.name}: ` +
      `${existing.versionSpecifier ?? existing.kind} is already selected, but ${dependentName} requires ` +
      `${requested.versionSpecifier ?? requested.kind}. Only a single version per private package is supported.`
  );
}

function assertSubdirectory(rootDirPath: string, outDirPath: string): void {
  const relativePath = path.relative(rootDirPath, outDirPath);
  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) return;

  console.error(chalk.red(`Output directory must be a subdirectory of the project root: ${outDirPath}`));
  process.exit(1);
}

function findInstalledPackageDir(rootDirPath: string, packageName: string): string {
  const unscopedName = toUnscopedPackageName(packageName);
  // realpathSync resolves the isolated linker's symlink so copies read (and the copy filter
  // computes relative paths against) the actual package directory.
  const directDirPath = path.join(rootDirPath, 'node_modules', '@willbooster', unscopedName);
  if (fs.existsSync(path.join(directDirPath, 'package.json'))) {
    return fs.realpathSync(directDirPath);
  }
  // Bun's isolated linker keeps transitive-only dependencies out of the root node_modules;
  // search the .bun store for the package before giving up.
  const bunStoreDirPath = path.join(rootDirPath, 'node_modules', '.bun');
  try {
    for (const dirent of fs.readdirSync(bunStoreDirPath, { withFileTypes: true })) {
      const candidateDirPath = path.join(bunStoreDirPath, dirent.name, 'node_modules', '@willbooster', unscopedName);
      if (fs.existsSync(path.join(candidateDirPath, 'package.json'))) {
        return fs.realpathSync(candidateDirPath);
      }
    }
  } catch {
    // No .bun store (hoisted install); fall through to the error below.
  }
  throw new Error(`Private package is not installed: ${packageName} (${directDirPath})`);
}

function findPrivateDependencies(
  packageJson: PackageJson,
  outDirPath: string,
  registryOutDirPath: string
): PrivatePackage[] {
  const privatePackages = new Map<string, PrivatePackage>();
  for (const key of dependencyKeys) {
    const dependencies = packageJson[key];
    if (!dependencies) continue;

    for (const [name, value] of Object.entries(dependencies)) {
      const isGit = isPrivateGitDependency(value);
      if (!isGit && !isPrivateRegistryDependency(name, value)) continue;
      if (isGit && !name.startsWith('@willbooster/')) {
        throw new Error(`Private git dependency must be an @willbooster package: ${name}`);
      }
      const unscopedName = toUnscopedPackageName(name);
      // Dependency names become external data once nested manifests come from downloaded
      // tarballs; reject anything (path separators, `..`, hidden-file prefixes) that could
      // escape the output directory the name is joined into before it is recursively deleted.
      if (!/^[\w.-]+$/.test(unscopedName) || unscopedName.startsWith('.')) {
        throw new Error(`Invalid private package name: ${name}`);
      }
      const requested: PrivatePackage = {
        name,
        kind: isGit ? 'git' : 'registry',
        sourceDirPath: undefined,
        targetDirPath: path.join(isGit ? outDirPath : registryOutDirPath, unscopedName),
        versionSpecifier: isGit ? undefined : (value as string),
      };
      const existing = privatePackages.get(name);
      privatePackages.set(name, existing ? mergeSameManifestRequirement(existing, requested) : requested);
    }
  }
  return [...privatePackages.values()];
}

/**
 * A manifest may legitimately request one package from several dependency sections (e.g. an exact
 * devDependencies pin alongside a peerDependencies range): prefer the exact pin, and fail loudly
 * only when the requirements genuinely diverge.
 */
function mergeSameManifestRequirement(existing: PrivatePackage, requested: PrivatePackage): PrivatePackage {
  if (existing.kind === requested.kind && existing.versionSpecifier === requested.versionSpecifier) return existing;

  if (existing.kind === requested.kind) {
    if (isExactVersion(existing.versionSpecifier) && !isExactVersion(requested.versionSpecifier)) return existing;
    if (!isExactVersion(existing.versionSpecifier) && isExactVersion(requested.versionSpecifier)) return requested;
  }
  throw new Error(
    `Conflicting requirements for ${existing.name} within one manifest: ` +
      `${existing.versionSpecifier ?? existing.kind} vs ${requested.versionSpecifier ?? requested.kind}.`
  );
}

function isExactVersion(specifier: string | undefined): boolean {
  return !!specifier && /^\d/.test(specifier);
}

async function replacePrivateDependencies(
  rootDirPath: string,
  privatePackages: Map<string, PrivatePackage>
): Promise<void> {
  for (const privatePackage of privatePackages.values()) {
    for (const packageJsonPath of await findPackageJsonPaths(privatePackage.targetDirPath)) {
      const packageJson = await readPackageJson(packageJsonPath);
      if (!replacePackageJsonDependencies(packageJsonPath, packageJson, privatePackages)) continue;

      await fs.promises.writeFile(packageJsonPath, `${JSON.stringify(packageJson, undefined, 2)}\n`, 'utf8');
      console.info(`Rewrote private dependencies in ${path.relative(rootDirPath, packageJsonPath)}`);
    }
  }
}

function replacePackageJsonDependencies(
  packageJsonPath: string,
  packageJson: PackageJson,
  privatePackages: Map<string, PrivatePackage>
): boolean {
  let changed = false;
  for (const key of dependencyKeys) {
    const dependencies = packageJson[key];
    if (!dependencies) continue;

    for (const [name, value] of Object.entries(dependencies)) {
      if (!isPrivateGitDependency(value) && !isPrivateRegistryDependency(name, value)) continue;
      const targetPackage = privatePackages.get(name);
      if (!targetPackage) continue;

      dependencies[name] = `file:${path.relative(path.dirname(packageJsonPath), targetPackage.targetDirPath)}`;
      changed = true;
    }
  }
  return changed;
}

async function findPackageJsonPaths(dirPath: string): Promise<string[]> {
  if (!fs.existsSync(dirPath)) return [];

  const packageJsonPaths: string[] = [];
  for (const dirent of await fs.promises.readdir(dirPath, { withFileTypes: true })) {
    if (dirent.name === 'node_modules' || dirent.name === '.git') continue;

    const childPath = path.join(dirPath, dirent.name);
    if (dirent.isDirectory()) {
      packageJsonPaths.push(...(await findPackageJsonPaths(childPath)));
      continue;
    }
    if (dirent.isFile() && dirent.name === 'package.json') {
      packageJsonPaths.push(childPath);
    }
  }
  return packageJsonPaths;
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJson> {
  return JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8')) as PackageJson;
}

function toUnscopedPackageName(packageName: string): string {
  return packageName.replace(/^@willbooster(?:-private)?\//, '');
}

function printDryRunResult(outDirPath: string, privatePackages: Map<string, PrivatePackage>): void {
  console.info(`[dry-run] Would recreate ${outDirPath}`);
  for (const privatePackage of privatePackages.values()) {
    console.info(
      privatePackage.kind === 'git'
        ? `[dry-run] Would copy ${privatePackage.name}: ${privatePackage.sourceDirPath ?? '(installed under node_modules)'}`
        : `[dry-run] Would download ${privatePackage.name}@${privatePackage.versionSpecifier} to ${privatePackage.targetDirPath}`
    );
  }
  console.info(`[dry-run] Would rewrite copied private dependencies to file:../<name>`);
}
