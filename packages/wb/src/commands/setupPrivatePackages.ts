import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { findDescendantProjects, findRootAndSelfProjects, type FoundProjects } from '../project.js';
import type { PrivateRegistryAuth } from '../utils/privateRegistry.js';
import {
  PRIVATE_REGISTRY_SCOPE,
  downloadAndExtractRegistryPackage,
  installedVersionSatisfies,
  isPrivateGitDependency,
  isPrivateRegistryDependency,
  resolvePrivateRegistryAuth,
  specifierSubset,
} from '../utils/privateRegistry.js';

interface PrivatePackage {
  name: string;
  kind: 'git' | 'registry';
  /**
   * Undefined for registry packages that must be downloaded; set for git packages and for
   * registry packages whose installed copy in node_modules already satisfies the specifier
   * (so CI steps without registry credentials can still materialize them).
   */
  sourceDirPath: string | undefined;
  targetDirPath: string;
  versionSpecifier: string | undefined;
  /** The materialized version once an installed copy is selected or a download is extracted. */
  resolvedVersion: string | undefined;
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
    'Materialize private dependencies for Docker builds: copy git dependencies, reuse installed @willbooster-private/* registry packages whose exact-version or semver-range specifier the installed copy satisfies, and download the rest (auth via .npmrc / ~/.npmrc locally, or VERDACCIO_TOKEN on CI; dist-tag specifiers such as `latest` always download). ' +
    'The Dockerfile must COPY the generated directories (e.g. `COPY @willbooster/ @willbooster/` and `COPY @willbooster-private/ @willbooster-private/`) so the in-image install resolves the rewritten file: paths.',
  builder,
  async handler(argv) {
    const rootAndSelf = findRootAndSelfProjects(argv, false);
    if (!rootAndSelf) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }
    // Resolve the descendant set from the repository ROOT (not the current directory) so the
    // command scans the root manifest and every workspace manifest regardless of where it runs:
    // findDescendantProjects returns only the current project when invoked from a workspace.
    const projects = await findDescendantProjects(argv, false, rootAndSelf.root.dirPath);
    if (!projects) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    // Scan the root manifest and every workspace manifest: a private dependency may be declared in
    // a sub-package (e.g. packages/server) rather than the root, yet it still materializes at the
    // repository root so `wb optimizeForDockerBuild` resolves it uniformly.
    try {
      await materializePrivatePackages(projects.root.dirPath, collectManifests(projects), {
        outDir: argv.outDir,
        dryRun: Boolean(argv.dryRun),
      });
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  },
};

export interface MaterializePrivatePackagesOptions {
  /** Directory (relative to the repository root) that git dependencies are copied into. */
  outDir?: string;
  dryRun?: boolean;
}

/** The root manifest followed by each distinct workspace manifest. */
export function collectManifests(projects: FoundProjects): PackageJson[] {
  const manifestsByDirPath = new Map<string, PackageJson>();
  for (const project of [projects.root, ...projects.descendants]) {
    if (!manifestsByDirPath.has(project.dirPath)) manifestsByDirPath.set(project.dirPath, project.packageJson);
  }
  return [...manifestsByDirPath.values()];
}

export async function materializePrivatePackages(
  rootProjectDirPath: string,
  manifestPackageJsons: PackageJson[],
  options: MaterializePrivatePackagesOptions = {}
): Promise<void> {
  const { outDir = '@willbooster', dryRun = false } = options;

  // Output paths are recursively DELETED before being recreated, so none of them may contain a
  // symlink component: a symlink (e.g. `escape -> node_modules`, or `@willbooster-private`
  // itself linking elsewhere) would either smuggle the delete past the lexical overlap guards
  // or destroy the symlink's target. Rejecting canonical/lexical mismatches keeps every
  // destructive operation on the intended lexical location. These guards THROW (not process.exit)
  // so the automatic `wb optimizeForDockerBuild --outside` caller can catch them and continue
  // non-fatally; the explicit command's handler catches and exits.
  const rootDirPath = canonicalizePath(rootProjectDirPath);
  const resolveOutputDirPath = (relativeOrAbsolutePath: string, label: string): string => {
    const lexicalPath = path.resolve(rootDirPath, relativeOrAbsolutePath);
    const canonicalPath = canonicalizePath(lexicalPath);
    if (canonicalPath !== lexicalPath) {
      throw new Error(`${label} must not contain symlinks (${lexicalPath} resolves to ${canonicalPath}).`);
    }
    return lexicalPath;
  };
  const outDirPath = resolveOutputDirPath(outDir, '--out-dir');
  assertSubdirectory(rootDirPath, outDirPath);
  // Registry packages always materialize at the repository root: `wb optimizeForDockerBuild`
  // resolves them from `<root>/@willbooster-private` regardless of `--out-dir`.
  const registryOutDirPath = resolveOutputDirPath(
    PRIVATE_REGISTRY_SCOPE,
    `The ${PRIVATE_REGISTRY_SCOPE} output directory`
  );
  if (pathsOverlap(outDirPath, registryOutDirPath)) {
    // e.g. `--out-dir @willbooster-private` or `--out-dir @willbooster-private/sub`: the
    // registry step recursively deletes registryOutDirPath, which would destroy the git
    // packages copied into an equal or NESTED directory moments earlier.
    throw new Error(`--out-dir must not overlap the ${PRIVATE_REGISTRY_SCOPE} registry output directory.`);
  }
  const stagingDirPath = resolveOutputDirPath(
    path.join('.tmp', 'wb-private-registry-staging'),
    'The registry staging directory'
  );
  const gitStagingDirPath = resolveOutputDirPath(
    path.join('.tmp', 'wb-private-git-staging'),
    'The git staging directory'
  );
  if (pathsOverlap(outDirPath, canonicalizePath(path.join(rootDirPath, 'node_modules')))) {
    // The recursive delete of outDirPath would destroy the installed sources the copies read.
    throw new Error('--out-dir must not overlap node_modules.');
  }
  for (const [stagingLabel, stagingPath] of [
    ['registry', stagingDirPath],
    ['git', gitStagingDirPath],
  ] as const) {
    if (pathsOverlap(outDirPath, stagingPath)) {
      // Each staging step recreates its directory, silently discarding anything copied into an
      // equal or nested --out-dir moments earlier.
      throw new Error(`--out-dir must not overlap the ${stagingLabel} staging directory (${stagingPath}).`);
    }
  }
  if (path.relative(rootDirPath, outDirPath) !== '@willbooster') {
    // Pre-existing limitation of the option: the Docker manifest rewrite has no access to it.
    console.warn(
      chalk.yellow(
        'Note: wb optimizeForDockerBuild rewrites git dependencies to <root>/@willbooster; a custom --out-dir requires a matching Dockerfile layout.'
      )
    );
  }
  const privatePackages = await collectPrivatePackages(
    rootDirPath,
    manifestPackageJsons,
    outDirPath,
    registryOutDirPath
  );

  if (dryRun) {
    printDryRunResult(outDirPath, privatePackages);
    return;
  }

  // Registry packages whose installed copy satisfies the specifier are copied from
  // node_modules; only the rest are downloaded, so registry credentials are needed only when a
  // download actually happens (CI test steps deliberately receive no Verdaccio token).
  const downloadedPackages = [...privatePackages.values()].filter((p) => p.kind === 'registry' && !p.sourceDirPath);
  // Resolve required configuration BEFORE deleting the existing materializations, so a missing
  // registry configuration cannot destroy a previously usable output tree. Throw (rather than
  // exit) so callers can decide: `wb setup-private-packages` reports it and exits, while the
  // automatic `wb optimizeForDockerBuild --outside` step catches it and continues, leaving the
  // existing output untouched (nothing has been deleted yet at this point).
  const auth = downloadedPackages.length > 0 ? resolvePrivateRegistryAuth(rootDirPath) : undefined;
  if (downloadedPackages.length > 0 && !auth) {
    throw new Error(
      `Cannot download ${downloadedPackages.map((p) => p.name).join(', ')}: no registry configured for the ${PRIVATE_REGISTRY_SCOPE} scope; ` +
        `add "${PRIVATE_REGISTRY_SCOPE}:registry=..." to .npmrc or ~/.npmrc. Only installed copies satisfying an exact version or ` +
        'semver range are reused without registry access; dist-tag specifiers (e.g. `latest`) always require it.'
    );
  }

  const copiedPackages = [...privatePackages.values()].filter((p) => p.kind === 'git');
  const registryPackages = [...privatePackages.values()].filter((p) => p.kind === 'registry');

  // Copy git packages into a staging directory and swap it in only after every copy succeeded,
  // mirroring the registry staging below: a copy that fails partway (e.g. a dangling symlink in
  // the installed source) must not leave a half-populated @willbooster tree that the automatic
  // optimizeForDockerBuild caller — which catches the failure and continues — would then rewrite
  // dependencies against. Both output directories always exist afterwards: Dockerfiles COPY them
  // unconditionally, and a missing source path fails the build.
  await fs.promises.rm(gitStagingDirPath, { recursive: true, force: true });
  await fs.promises.mkdir(gitStagingDirPath, { recursive: true });
  try {
    for (const privatePackage of copiedPackages) {
      await copyInstalledPackage(
        rootDirPath,
        privatePackage,
        path.join(gitStagingDirPath, path.relative(outDirPath, privatePackage.targetDirPath))
      );
    }
    await fs.promises.rm(outDirPath, { recursive: true, force: true });
    await fs.promises.rename(gitStagingDirPath, outDirPath);
  } catch (error) {
    await fs.promises.rm(gitStagingDirPath, { recursive: true, force: true });
    throw error;
  }

  if (registryPackages.length > 0) {
    // Download into a staging directory and swap it in only after every download succeeded, so
    // a failing registry/token/extraction cannot destroy the last usable materialization.
    const toStagedPath = (targetDirPath: string): string =>
      path.join(stagingDirPath, path.relative(registryOutDirPath, targetDirPath));
    await fs.promises.rm(stagingDirPath, { recursive: true, force: true });
    await fs.promises.mkdir(stagingDirPath, { recursive: true });
    try {
      for (const privatePackage of registryPackages) {
        if (privatePackage.sourceDirPath) {
          await copyInstalledPackage(rootDirPath, privatePackage, toStagedPath(privatePackage.targetDirPath));
        } else {
          await downloadAndExtractRegistryPackage(
            // downloadedPackages is non-empty on this path, so the auth check above passed.
            auth!,
            privatePackage.name,
            privatePackage.versionSpecifier ?? 'latest',
            toStagedPath(privatePackage.targetDirPath)
          );
          privatePackage.resolvedVersion = readInstalledVersion(
            toStagedPath(privatePackage.targetDirPath),
            privatePackage.name
          );
          console.info(
            `Downloaded ${privatePackage.name} to ${path.relative(rootDirPath, privatePackage.targetDirPath)}`
          );
        }
        // A downloaded package may itself depend on private packages that were not visible
        // before extraction; materialize them too. Installed copies were already deep-scanned
        // by collectPrivatePackages.
        if (!privatePackage.sourceDirPath) {
          await collectNestedPrivatePackages(
            rootDirPath,
            auth!,
            privatePackage,
            privatePackages,
            outDirPath,
            registryOutDirPath,
            toStagedPath
          );
        }
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

  await replacePrivateDependencies(rootDirPath, privatePackages);
  console.info(
    `Ensure the Dockerfile COPYs ${path.relative(rootDirPath, outDirPath)}/ and ${PRIVATE_REGISTRY_SCOPE}/ into the image before installing dependencies.`
  );
}

async function collectPrivatePackages(
  rootDirPath: string,
  manifestPackageJsons: PackageJson[],
  outDirPath: string,
  registryOutDirPath: string
): Promise<Map<string, PrivatePackage>> {
  const privatePackages = new Map<string, PrivatePackage>();
  // Seed from every manifest (root + workspaces); one private package may be requested by several
  // manifests, so merge duplicates the same way nested discovery does — keep the narrower
  // compatible requirement and fail loudly on a genuine conflict.
  const packagesToProcess: PrivatePackage[] = [];
  const queuedPackages = new Map<string, PrivatePackage>();
  for (const packageJson of manifestPackageJsons) {
    for (const requested of findPrivateDependencies(packageJson, outDirPath, registryOutDirPath)) {
      const queued = queuedPackages.get(requested.name);
      if (!queued) {
        queuedPackages.set(requested.name, requested);
        packagesToProcess.push(requested);
        continue;
      }
      const narrower = narrowerCompatibleRequirement(queued, requested);
      if (narrower === undefined) {
        assertNoVersionConflict(queued, requested, packageJson.name ?? 'a workspace manifest');
      } else {
        queued.versionSpecifier = narrower.versionSpecifier;
      }
    }
  }

  for (let index = 0; index < packagesToProcess.length; index++) {
    const privatePackage = packagesToProcess[index];
    if (!privatePackage) continue;
    if (privatePackages.has(privatePackage.name)) continue;

    if (privatePackage.kind === 'git') {
      privatePackage.sourceDirPath = findInstalledPackageDir(rootDirPath, privatePackage.name);
    } else {
      const installed = findInstalledRegistryPackage(rootDirPath, privatePackage);
      privatePackage.sourceDirPath = installed?.dirPath;
      privatePackage.resolvedVersion = installed?.version;
    }
    // Selected BEFORE the deep scan: a manifest inside the package may refer back to the package
    // itself, and that requirement must be validated against the selection (assertNoVersionConflict
    // below), never narrow the already-selected specifier.
    privatePackages.set(privatePackage.name, privatePackage);
    // Nested private dependencies of an installed package are discoverable right away; registry
    // packages without a usable installed copy are inspected after download instead
    // (collectNestedPrivatePackages).
    if (privatePackage.sourceDirPath) {
      for (const packageJsonPath of await findPackageJsonPaths(privatePackage.sourceDirPath)) {
        const packageJson = await readPackageJson(packageJsonPath);
        for (const nested of findPrivateDependencies(packageJson, outDirPath, registryOutDirPath)) {
          const queued = queuedPackages.get(nested.name);
          if (!queued) {
            queuedPackages.set(nested.name, nested);
            packagesToProcess.push(nested);
            continue;
          }
          if (privatePackages.has(nested.name)) {
            // Already materialized (or selected): the requirement must admit that selection.
            assertNoVersionConflict(queued, nested, privatePackage.name);
          } else {
            // Still queued: keep the NARROWER compatible requirement so discovery order cannot
            // turn compatible constraints (e.g. `^1.0.0` and `1.2.3`) into a spurious conflict.
            const narrower = narrowerCompatibleRequirement(queued, nested);
            if (narrower === undefined) {
              assertNoVersionConflict(queued, nested, privatePackage.name);
            } else {
              queued.versionSpecifier = narrower.versionSpecifier;
            }
          }
        }
      }
    }
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
  // place only after every download succeeded); git packages are copied straight to their final
  // location, so their manifest must be read there.
  const extractedDirPath =
    extractedPackage.kind === 'registry'
      ? toStagedPath(extractedPackage.targetDirPath)
      : extractedPackage.targetDirPath;
  // Scan EVERY manifest of the materialized package (org git dependencies are whole monorepo
  // checkouts with packages/*/package.json), mirroring collectPrivatePackages' deep scan — the
  // dependency-rewrite step walks the same set, so anything declared there must be materialized.
  for (const packageJsonPath of await findPackageJsonPaths(extractedDirPath)) {
    for (const nested of findPrivateDependencies(
      await readPackageJson(packageJsonPath),
      outDirPath,
      registryOutDirPath
    )) {
      const existing = privatePackages.get(nested.name);
      if (existing) {
        if (existing.kind === 'registry' && !existing.sourceDirPath && existing.resolvedVersion === undefined) {
          // Still awaiting its download (no installed copy selected, nothing extracted yet): keep
          // the NARROWER compatible requirement, exactly as collectPrivatePackages does for
          // queued packages, so late-discovered nested constraints cannot fabricate conflicts.
          const narrower = narrowerCompatibleRequirement(existing, nested);
          if (narrower === undefined) {
            assertNoVersionConflict(existing, nested, extractedPackage.name);
          } else {
            existing.versionSpecifier = narrower.versionSpecifier;
          }
        } else {
          // Collapsing different requested versions into one materialization would silently
          // violate the dependent's requirement, so conflicts must fail loudly.
          assertNoVersionConflict(existing, nested, extractedPackage.name);
        }
        continue;
      }

      if (nested.kind === 'git') {
        nested.sourceDirPath = findInstalledPackageDir(rootDirPath, nested.name);
        await copyInstalledPackage(rootDirPath, nested, nested.targetDirPath);
      } else {
        const installed = findInstalledRegistryPackage(rootDirPath, nested);
        nested.sourceDirPath = installed?.dirPath;
        nested.resolvedVersion = installed?.version;
        if (nested.sourceDirPath) {
          await copyInstalledPackage(rootDirPath, nested, toStagedPath(nested.targetDirPath));
        } else {
          await downloadAndExtractRegistryPackage(
            auth,
            nested.name,
            nested.versionSpecifier ?? 'latest',
            toStagedPath(nested.targetDirPath)
          );
          nested.resolvedVersion = readInstalledVersion(toStagedPath(nested.targetDirPath), nested.name);
          console.info(`Downloaded ${nested.name} (nested dependency) to ${nested.targetDirPath}`);
        }
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
}

/** `destinationDirPath` may differ from `targetDirPath` while registry packages stage. */
async function copyInstalledPackage(
  rootDirPath: string,
  privatePackage: PrivatePackage,
  destinationDirPath: string
): Promise<void> {
  // A registry package's tarball may legitimately contain node_modules/ content via
  // bundledDependencies; those files are part of the artifact and must survive the copy. Git
  // checkouts (and non-bundled names) still exclude node_modules, which holds locally installed
  // dependencies there.
  const bundledDependencyNames =
    privatePackage.kind === 'registry' ? readBundledDependencyNames(privatePackage.sourceDirPath!) : [];
  await fs.promises.cp(privatePackage.sourceDirPath!, destinationDirPath, {
    recursive: true,
    force: true,
    // Bun's isolated linker exposes installed packages through symlinks; the materialized tree
    // must contain real files (a copied absolute symlink would dangle inside the Docker image,
    // and later dependency rewriting would write through it into the shared store).
    dereference: true,
    filter: (src) => {
      const segments = path.relative(privatePackage.sourceDirPath!, src).split(path.sep);
      if (segments.includes('.git')) return false;
      const nodeModulesIndex = segments.indexOf('node_modules');
      if (nodeModulesIndex === -1) return true;
      if (bundledDependencyNames === true) return true;
      if (bundledDependencyNames.length === 0) return false;
      // The node_modules (and @scope) directories themselves must copy so bundled subtrees can;
      // only the first node_modules level filters — anything inside a bundled subtree belongs to
      // the artifact, including its own nested node_modules.
      const [first, second] = segments.slice(nodeModulesIndex + 1);
      if (first === undefined) return true;
      if (first.startsWith('@') && second === undefined) {
        return bundledDependencyNames.some((name) => name.startsWith(`${first}/`));
      }
      const packageName = first.startsWith('@') ? `${first}/${second}` : first;
      return bundledDependencyNames.includes(packageName);
    },
  });
  console.info(`Copied ${privatePackage.name} to ${path.relative(rootDirPath, privatePackage.targetDirPath)}`);
}

/** Declared bundled dependency names of the installed package; `true` bundles every dependency. */
function readBundledDependencyNames(sourceDirPath: string): string[] | true {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(sourceDirPath, 'package.json'), 'utf8')) as {
      bundleDependencies?: string[] | boolean;
      bundledDependencies?: string[] | boolean;
    };
    const bundled = packageJson.bundleDependencies ?? packageJson.bundledDependencies;
    if (bundled === true) return true;
    return Array.isArray(bundled) ? bundled.filter((name) => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The materialization for `existing` is already selected (a range resolves max-satisfying against
 * the registry — see downloadAndExtractRegistryPackage), so accept `requested` only when it is
 * guaranteed satisfied: `existing` must be a subset of it (every possible resolution of `existing`
 * then satisfies `requested`). Non-range specifiers (dist-tags, git URLs/revisions) must match
 * exactly.
 */
function assertNoVersionConflict(existing: PrivatePackage, requested: PrivatePackage, dependentName: string): void {
  if (existing.kind === requested.kind) {
    if (existing.versionSpecifier === requested.versionSpecifier) return;
    if (specifierSubset(existing.versionSpecifier, requested.versionSpecifier)) return;
    // Once the concrete materialized version is known (installed copy or extracted download), a
    // requirement it satisfies is compatible even when the original specifiers are not subsets
    // (e.g. `^1.0.0` resolved to 1.2.3 also satisfies a later exact `1.2.3`).
    if (
      existing.resolvedVersion !== undefined &&
      requested.versionSpecifier !== undefined &&
      installedVersionSatisfies(requested.versionSpecifier, existing.resolvedVersion)
    ) {
      return;
    }
  }

  throw new Error(
    `Conflicting requirements for ${existing.name}: ` +
      `${existing.versionSpecifier ?? existing.kind} is already selected, but ${dependentName} requires ` +
      `${requested.versionSpecifier ?? requested.kind}. Only a single version per private package is supported.`
  );
}

/**
 * Resolves symlinks in the deepest EXISTING ancestor of the path and reattaches the not-yet
 * existing remainder, so lexical containment/overlap checks operate on physical locations.
 */
function canonicalizePath(targetPath: string): string {
  let existingPath = path.resolve(targetPath);
  const remainderSegments: string[] = [];
  while (!fs.existsSync(existingPath)) {
    const parentPath = path.dirname(existingPath);
    if (parentPath === existingPath) break;
    remainderSegments.unshift(path.basename(existingPath));
    existingPath = parentPath;
  }
  try {
    return path.join(fs.realpathSync(existingPath), ...remainderSegments);
  } catch {
    return path.resolve(targetPath);
  }
}

/** Whether the two paths are equal or one contains the other. */
function pathsOverlap(a: string, b: string): boolean {
  return isEqualOrAncestorPath(a, b) || isEqualOrAncestorPath(b, a);
}

function isEqualOrAncestorPath(ancestorPath: string, descendantPath: string): boolean {
  const relativePath = path.relative(ancestorPath, descendantPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function assertSubdirectory(rootDirPath: string, outDirPath: string): void {
  const relativePath = path.relative(rootDirPath, outDirPath);
  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) return;

  throw new Error(`Output directory must be a subdirectory of the project root: ${outDirPath}`);
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
  // search the .bun store for the package before giving up. The store may legitimately hold
  // MULTIPLE resolutions of one package (different versions/revisions), and picking an arbitrary
  // one could silently materialize the wrong content — so ambiguity fails loudly.
  const bunStoreDirPath = path.join(rootDirPath, 'node_modules', '.bun');
  const candidateDirPaths = new Set<string>();
  try {
    for (const dirent of fs.readdirSync(bunStoreDirPath, { withFileTypes: true })) {
      const candidateDirPath = path.join(bunStoreDirPath, dirent.name, 'node_modules', '@willbooster', unscopedName);
      if (fs.existsSync(path.join(candidateDirPath, 'package.json'))) {
        candidateDirPaths.add(fs.realpathSync(candidateDirPath));
      }
    }
  } catch {
    // No .bun store (hoisted install); fall through to the error below.
  }
  if (candidateDirPaths.size === 1) return [...candidateDirPaths][0]!;
  if (candidateDirPaths.size > 1) {
    throw new Error(
      `Multiple installed resolutions found for ${packageName}: ${[...candidateDirPaths].join(', ')}. ` +
        'Deduplicate the dependency so a single resolution remains.'
    );
  }
  throw new Error(`Private package is not installed: ${packageName} (${directDirPath})`);
}

/**
 * The installed materialization of a registry package, when its version is statically known to
 * satisfy the specifier — steps without registry credentials (e.g. CI test steps, which
 * deliberately receive no Verdaccio token) reuse it instead of downloading. Returns undefined
 * (falling back to a download) when no unambiguously correct installed copy exists.
 */
function findInstalledRegistryPackage(
  rootDirPath: string,
  privatePackage: PrivatePackage
): { dirPath: string; version: string } | undefined {
  const specifier = privatePackage.versionSpecifier ?? 'latest';
  const relativeDirPath = path.join('node_modules', ...privatePackage.name.split('/'));
  const addCandidate = (candidates: Map<string, string>, dirPath: string): void => {
    const version = readInstalledVersion(dirPath, privatePackage.name);
    if (version && installedVersionSatisfies(specifier, version)) candidates.set(fs.realpathSync(dirPath), version);
  };
  // A root-level installation is THE lockfile resolution for the root dependency; the .bun store
  // is consulted only for transitive-only packages, where multiple satisfying resolutions may
  // coexist and picking one arbitrarily could materialize the wrong content.
  const directCandidates = new Map<string, string>();
  addCandidate(directCandidates, path.join(rootDirPath, relativeDirPath));
  if (directCandidates.size === 1) return toSingleCandidate(directCandidates);

  const storeCandidates = new Map<string, string>();
  try {
    for (const dirent of fs.readdirSync(path.join(rootDirPath, 'node_modules', '.bun'), { withFileTypes: true })) {
      addCandidate(storeCandidates, path.join(rootDirPath, 'node_modules', '.bun', dirent.name, relativeDirPath));
    }
  } catch {
    // No .bun store (hoisted install); fall back to downloading.
  }
  return toSingleCandidate(storeCandidates);
}

function toSingleCandidate(candidates: Map<string, string>): { dirPath: string; version: string } | undefined {
  const [entry] = candidates;
  return candidates.size === 1 && entry ? { dirPath: entry[0], version: entry[1] } : undefined;
}

function readInstalledVersion(dirPath: string, packageName: string): string | undefined {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf8')) as PackageJson;
    return packageJson.name === packageName && typeof packageJson.version === 'string'
      ? packageJson.version
      : undefined;
  } catch {
    return undefined;
  }
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
        resolvedVersion: undefined,
        targetDirPath: path.join(isGit ? outDirPath : registryOutDirPath, unscopedName),
        // The full git specifier is preserved so divergent URLs/revisions (#abc vs #def) are
        // detected as conflicts instead of silently collapsing into one copied package.
        versionSpecifier: value as string,
      };
      const existing = privatePackages.get(name);
      privatePackages.set(name, existing ? mergeSameManifestRequirement(existing, requested) : requested);
    }
  }
  return [...privatePackages.values()];
}

/**
 * A manifest may legitimately request one package from several dependency sections (e.g. an exact
 * devDependencies pin alongside a peerDependencies range). Keep the NARROWER requirement — its
 * max-satisfying resolution satisfies the wider one by definition (an exact pin is the narrowest
 * range) — and fail loudly when the requirements genuinely diverge.
 */
function mergeSameManifestRequirement(existing: PrivatePackage, requested: PrivatePackage): PrivatePackage {
  const narrower = narrowerCompatibleRequirement(existing, requested);
  if (narrower) return narrower;
  throw new Error(
    `Conflicting requirements for ${existing.name} within one manifest: ` +
      `${existing.versionSpecifier ?? existing.kind} vs ${requested.versionSpecifier ?? requested.kind}.`
  );
}

/**
 * The requirement whose max-satisfying resolution is guaranteed to satisfy the other (an exact
 * pin is the narrowest range), or undefined when neither subsumes the other.
 */
function narrowerCompatibleRequirement(
  existing: PrivatePackage,
  requested: PrivatePackage
): PrivatePackage | undefined {
  if (existing.kind !== requested.kind) return undefined;
  if (existing.versionSpecifier === requested.versionSpecifier) return existing;
  if (specifierSubset(existing.versionSpecifier, requested.versionSpecifier)) return existing;
  if (specifierSubset(requested.versionSpecifier, existing.versionSpecifier)) return requested;
  return undefined;
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
      privatePackage.sourceDirPath
        ? `[dry-run] Would copy ${privatePackage.name}: ${privatePackage.sourceDirPath}`
        : privatePackage.kind === 'git'
          ? `[dry-run] Would copy ${privatePackage.name}: (installed under node_modules)`
          : `[dry-run] Would download ${privatePackage.name}@${privatePackage.versionSpecifier} to ${privatePackage.targetDirPath}`
    );
  }
  console.info(`[dry-run] Would rewrite copied private dependencies to file:../<name>`);
}
