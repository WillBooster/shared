import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import fg from 'fast-glob';
import { simpleGit } from 'simple-git';
import { parse as parseToml } from 'smol-toml';
import type { PackageJson } from 'type-fest';
import { z } from 'zod';

import { getOctokit, gitHubUtil } from './utils/githubUtil.js';
import { globIgnore } from './utils/globUtil.js';

export interface PackageConfig {
  dirPath: string;
  dockerfile: string;
  isRoot: boolean;
  isPublicRepo: boolean;
  isReferredByOtherRepo: boolean;
  repository?: string;
  repoAuthor?: string;
  repoName?: string;
  isWillBoosterRepo: boolean;
  isCloudflare: boolean;
  doesContainWranglerConfig: boolean;
  isRailway: boolean;
  isBun: boolean;
  isEsmPackage: boolean;
  isWillBoosterConfigs: boolean;
  // dependency information
  /** Directories containing Cargo.toml (relative to dirPath, root-most first). Empty if the repo has no Rust code. */
  cargoTomlDirPaths: string[];
  doesContainSubPackageJsons: boolean;
  doesContainDockerfile: boolean;
  doesContainGemfile: boolean;
  doesContainGoMod: boolean;
  doesContainPackageJson: boolean;
  doesContainPoetryLock: boolean;
  doesContainUvLock: boolean;
  doesContainPomXml: boolean;
  doesContainPubspecYaml: boolean;
  doesContainTauriConfig: boolean;
  doesContainTauriConfigInPackages: boolean;
  doesContainTemplateYaml: boolean;
  doesContainVscodeSettingsJson: boolean;
  // source code files
  doesContainJavaScript: boolean;
  doesContainTypeScript: boolean;
  doesContainJsxOrTsx: boolean;
  doesContainJava: boolean;
  doesContainJavaScriptInPackages: boolean;
  doesContainTypeScriptInPackages: boolean;
  doesContainJsxOrTsxInPackages: boolean;
  doesContainJavaInPackages: boolean;

  depending: {
    blitz: boolean;
    firebase: boolean;
    genI18nTs: boolean;
    litestream: boolean;
    next: boolean;
    playwrightTest: boolean;
    playwrightRuntime: boolean;
    prisma: boolean;
    pyright: boolean;
    react: boolean;
    reactNative: boolean;
    semanticRelease: boolean;
    storybook: boolean;
    tauri: boolean;
    vinext: boolean;
    vite: boolean;
    wb: boolean;
    chakra: boolean;
    drizzle: boolean;
  };
  release: {
    branches: string[];
    github: boolean;
    npm: boolean;
  };
  hasVersionSettings: boolean;
  miseTasks: Record<string, string>;
  packageJson?: PackageJson;
  wbfyJson?: WbfyJson;
}

type WbfyJson = z.infer<typeof wbfyJsonSchema>;

const wbfyJsonSchema = z.object({
  typos: z
    .object({
      all: z.record(z.string(), z.string()).optional(),
      doc: z.record(z.string(), z.string()).optional(),
      ts: z.record(z.string(), z.string()).optional(),
      text: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

export async function getPackageConfig(
  dirPath: string,
  rootConfig?: PackageConfig
): Promise<PackageConfig | undefined> {
  const packageJsonPath = path.resolve(dirPath, 'package.json');
  try {
    const doesContainPackageJson = fs.existsSync(packageJsonPath);
    let dependencies: PackageJson['dependencies'] = {};
    let devDependencies: PackageJson['devDependencies'] = {};
    let packageJson: PackageJson = {};
    let esmPackage = false;
    if (doesContainPackageJson) {
      const packageJsonText = fs.readFileSync(packageJsonPath, 'utf8');
      packageJson = JSON.parse(packageJsonText) as PackageJson;
      dependencies = packageJson.dependencies ?? {};
      devDependencies = packageJson.devDependencies ?? {};
      esmPackage = packageJson.type === 'module';
    }

    let releaseBranches: string[] = [];
    let releasePlugins: string[] = [];
    try {
      const releasercJsonPath = path.resolve(dirPath, '.releaserc.json');
      const json = JSON.parse(await fsp.readFile(releasercJsonPath, 'utf8')) as
        | {
            branches: string[];
            plugins?: string[][];
          }
        | undefined;
      releaseBranches = json?.branches ?? [];
      releasePlugins = json?.plugins?.flat() ?? [];
    } catch {
      // do nothing
    }

    const isRoot =
      path.basename(path.resolve(dirPath, '..')) !== 'packages' ||
      !fs.existsSync(path.resolve(dirPath, '..', '..', 'package.json'));

    let repoInfo: Record<string, unknown> | undefined;
    if (isRoot) {
      repoInfo = await fetchRepoInfo(dirPath, packageJson);
    }

    let hasVersionSettings = hasVersionSettingsFile(dirPath);
    for (const prefix of ['java', 'node', 'python']) {
      if (fs.existsSync(path.resolve(dirPath, `.${prefix}-version`))) {
        hasVersionSettings = true;
        break;
      }
    }

    let dockerfile = '';
    try {
      dockerfile = await fsp.readFile(path.resolve(dirPath, 'Dockerfile'), 'utf8');
    } catch {
      // do nothing
    }

    // Read wbfy.json
    const wbfyJsonPath = path.resolve(dirPath, 'wbfy.json');
    let wbfyJson: WbfyJson | undefined;
    try {
      const wbfyJsonText = await fsp.readFile(wbfyJsonPath, 'utf8');
      wbfyJson = wbfyJsonSchema.parse(JSON.parse(wbfyJsonText));
    } catch {
      // do nothing
    }

    const repoFullName = typeof repoInfo?.full_name === 'string' ? repoInfo.full_name : undefined;
    let repoAuthor: string | undefined;
    let repoName: string | undefined;
    if (repoFullName) {
      const repoParts = repoFullName.split('/');
      if (repoParts.length >= 2) {
        repoAuthor = repoParts[0];
        repoName = repoParts[1];
      }
    }
    const repository = repoFullName ? `github:${repoFullName}` : undefined;
    // Tauri officially supports JSON, JSON5, and TOML configuration formats.
    const doesContainTauriConfig = ['tauri.conf.json', 'tauri.conf.json5', 'Tauri.toml'].some((fileName) =>
      fs.existsSync(path.resolve(dirPath, 'src-tauri', fileName))
    );
    const config: PackageConfig = {
      dirPath,
      dockerfile,
      isRoot,
      isPublicRepo: repoInfo?.private === false,
      isReferredByOtherRepo: !!packageJson.files,
      repository,
      repoAuthor,
      repoName,
      isWillBoosterRepo: Boolean(
        repository?.startsWith('github:WillBooster/') || repository?.startsWith('github:WillBoosterLab/')
      ),
      isCloudflare: detectCloudflare(dirPath, packageJson),
      doesContainWranglerConfig: detectWranglerConfig(dirPath),
      isRailway: detectRailway(dirPath, packageJson),
      isBun:
        rootConfig?.isBun ||
        fs.existsSync(path.join(dirPath, 'bun.lockb')) ||
        fs.existsSync(path.join(dirPath, 'bun.lock')) ||
        // Some repos gitignore bun.lock, so it may be missing on fresh clones.
        // bunfig.toml is committed and generated only for Bun projects, making it a reliable signal.
        fs.existsSync(path.join(dirPath, 'bunfig.toml')),
      isEsmPackage: esmPackage,
      isWillBoosterConfigs: packageJsonPath.includes('/willbooster-configs'),
      cargoTomlDirPaths: findCargoTomlDirPaths(dirPath),
      doesContainSubPackageJsons: containsAny('packages/**/package.json', dirPath),
      doesContainDockerfile: !!dockerfile || fs.existsSync(path.resolve(dirPath, 'docker-compose.yml')),
      doesContainGemfile: fs.existsSync(path.resolve(dirPath, 'Gemfile')),
      doesContainGoMod: fs.existsSync(path.resolve(dirPath, 'go.mod')),
      doesContainPackageJson: fs.existsSync(path.resolve(dirPath, 'package.json')),
      doesContainPoetryLock: fs.existsSync(path.resolve(dirPath, 'poetry.lock')),
      doesContainUvLock: fs.existsSync(path.resolve(dirPath, 'uv.lock')),
      doesContainPomXml: fs.existsSync(path.resolve(dirPath, 'pom.xml')),
      doesContainPubspecYaml: fs.existsSync(path.resolve(dirPath, 'pubspec.yaml')),
      doesContainTauriConfig,
      doesContainTauriConfigInPackages: containsAny(
        'packages/**/src-tauri/{tauri.conf.json,tauri.conf.json5,Tauri.toml}',
        dirPath
      ),
      doesContainTemplateYaml: fs.existsSync(path.resolve(dirPath, 'template.yaml')),
      doesContainVscodeSettingsJson: fs.existsSync(path.resolve(dirPath, '.vscode', 'settings.json')),
      doesContainJavaScript: containsAny('{app,src,test,scripts}/**/*.{cjs,mjs,js,jsx}', dirPath),
      doesContainTypeScript: containsAny('{app,src,test,scripts}/**/*.{cts,mts,ts,tsx}', dirPath),
      doesContainJsxOrTsx: containsAny('{app,src,test}/**/*.{t,j}sx', dirPath),
      doesContainJava: containsAny('**/*.java', dirPath),
      doesContainJavaScriptInPackages: containsAny('packages/**/{app,src,test,scripts}/**/*.{cjs,mjs,js,jsx}', dirPath),
      doesContainTypeScriptInPackages: containsAny('packages/**/{app,src,test,scripts}/**/*.{cts,mts,ts,tsx}', dirPath),
      doesContainJsxOrTsxInPackages: containsAny('packages/**/{app,src,test}/**/*.{t,j}sx', dirPath),
      doesContainJavaInPackages: containsAny('packages/**/*.java', dirPath),
      depending: {
        blitz: !!dependencies.blitz,
        chakra: !!devDependencies['@chakra-ui/cli'],
        drizzle: !!dependencies['drizzle-orm'] || !!devDependencies['drizzle-kit'],
        firebase: !!devDependencies['firebase-tools'],
        genI18nTs: !!dependencies['gen-i18n-ts'] || !!devDependencies['gen-i18n-ts'],
        litestream: dockerfile.includes('install-litestream.sh'),
        react: !!dependencies.react,
        next: !!dependencies.next,
        playwrightTest:
          !!dependencies['@playwright/test'] || !!devDependencies['@playwright/test'] || !!devDependencies.playwright,
        playwrightRuntime: doesImportPlaywrightAtRuntime(dirPath),
        prisma: !!dependencies['@prisma/client'] || !!devDependencies.prisma,
        pyright: !!devDependencies.pyright,
        reactNative: !!dependencies['react-native'],
        semanticRelease: !!(
          devDependencies['semantic-release'] ||
          releaseBranches.length > 0 ||
          releasePlugins.length > 0
        ),
        storybook: !!devDependencies['@storybook/react'],
        tauri:
          !!dependencies['@tauri-apps/api'] ||
          !!devDependencies['@tauri-apps/api'] ||
          !!dependencies['@tauri-apps/cli'] ||
          !!devDependencies['@tauri-apps/cli'] ||
          doesContainTauriConfig,
        vinext: !!dependencies.vinext || !!devDependencies.vinext,
        vite: !!dependencies.vite || !!devDependencies.vite,
        wb: !!dependencies['@willbooster/wb'] || !!devDependencies['@willbooster/wb'],
      },
      release: {
        branches: releaseBranches,
        github: releasePlugins.includes('@semantic-release/github'),
        npm: releasePlugins.includes('@semantic-release/npm'),
      },
      hasVersionSettings,
      miseTasks: await readMiseTasks(dirPath),
      packageJson,
      wbfyJson,
    };
    if (
      config.doesContainGemfile ||
      config.doesContainGoMod ||
      config.doesContainPackageJson ||
      config.doesContainPoetryLock ||
      config.doesContainUvLock ||
      config.doesContainPomXml ||
      config.doesContainPubspecYaml ||
      config.doesContainTauriConfig ||
      config.doesContainTemplateYaml
    ) {
      return config;
    }
  } catch {
    // do nothing
  }
}

function hasVersionSettingsFile(dirPath: string): boolean {
  const current = path.resolve(dirPath);
  return (
    fs.existsSync(path.join(current, 'mise.toml')) ||
    fs.existsSync(path.join(current, '.mise.toml')) ||
    fs.existsSync(path.join(current, '.tool-versions'))
  );
}

/**
 * Tells whether wbfy manages worker-configuration.d.ts for the package. The file is gitignored and untracked on the
 * assumption that `wrangler types` regenerates it on install, so all three steps must agree: the package has to own a
 * wrangler config (`wrangler types` exits non-zero without one) and to depend on wrangler (a package deploying via a
 * CI action cannot resolve the command). Otherwise wbfy would ignore and delete a file that nothing recreates.
 */
export function generatesWorkerTypes(config: PackageConfig): boolean {
  const packageJson = config.packageJson;
  return (
    config.doesContainWranglerConfig &&
    Boolean(packageJson?.dependencies?.['wrangler'] || packageJson?.devDependencies?.['wrangler'])
  );
}

/**
 * Tells whether the directory owns a Worker, unlike the isCloudflare heuristic, which also matches a package that
 * merely mentions wrangler in a script or workflow (e.g. the root of a monorepo whose Worker lives in a sub-package).
 */
export function detectWranglerConfig(dirPath: string): boolean {
  return ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].some((fileName) =>
    fs.existsSync(path.resolve(dirPath, fileName))
  );
}

function detectCloudflare(dirPath: string, packageJson: PackageJson): boolean {
  const scripts = packageJson.scripts;
  if (scripts && Object.values(scripts).some((script) => typeof script === 'string' && script.includes('wrangler'))) {
    return true;
  }

  if (detectWranglerConfig(dirPath)) {
    return true;
  }

  return workflowFilesMatch(dirPath, /cloudflare|wrangler/iu);
}

function detectRailway(dirPath: string, packageJson: PackageJson): boolean {
  const scripts = packageJson.scripts;
  if (scripts && Object.values(scripts).some((script) => typeof script === 'string' && script.includes('railway'))) {
    return true;
  }

  if (fs.existsSync(path.resolve(dirPath, '.railwayignore')) || fs.existsSync(path.resolve(dirPath, 'railway.json'))) {
    return true;
  }

  return workflowFilesMatch(dirPath, /railway/iu);
}

function workflowFilesMatch(dirPath: string, regex: RegExp): boolean {
  const workflowsPath = path.resolve(dirPath, '.github', 'workflows');
  try {
    return fs
      .readdirSync(workflowsPath)
      .some((fileName) => /\.ya?ml$/iu.test(fileName) && workflowFileMatches(workflowsPath, fileName, regex));
  } catch {
    return false;
  }
}

function workflowFileMatches(workflowsPath: string, fileName: string, regex: RegExp): boolean {
  try {
    return regex.test(fs.readFileSync(path.join(workflowsPath, fileName), 'utf8'));
  } catch {
    return false;
  }
}

async function readMiseTasks(dirPath: string): Promise<Record<string, string>> {
  const tasks: Record<string, string> = {};
  for (const fileName of ['mise.toml', '.mise.toml']) {
    const filePath = path.resolve(dirPath, fileName);
    try {
      const settings = parseToml(await fsp.readFile(filePath, 'utf8')) as { tasks?: Record<string, unknown> };
      for (const [name, value] of Object.entries(settings.tasks ?? {})) {
        tasks[name] = readMiseTaskCommand(value);
      }
    } catch {
      // Missing or temporarily invalid mise files should not block other wbfy generators.
    }
  }
  return tasks;
}

function readMiseTaskCommand(value: unknown): string {
  if (typeof value === 'string') return value;
  // Preserve array-form mise commands so recursion checks can still see package script calls.
  if (Array.isArray(value)) return value.filter((command): command is string => typeof command === 'string').join('\n');
  if (value && typeof value === 'object') return readMiseTaskCommand((value as { run?: unknown }).run);
  return '';
}

function containsAny(pattern: string, dirPath: string): boolean {
  return fg.globSync(pattern, { dot: true, cwd: dirPath, ignore: globIgnore }).length > 0;
}

function findCargoTomlDirPaths(dirPath: string): string[] {
  return fg
    .globSync('**/Cargo.toml', { dot: true, cwd: dirPath, ignore: globIgnore })
    .map((filePath) => path.dirname(filePath))
    .toSorted((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

function doesImportPlaywrightAtRuntime(dirPath: string): boolean {
  const files = fg.globSync('{app,src}/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}', {
    dot: true,
    cwd: dirPath,
    ignore: [...globIgnore, '**/__tests__/**', '**/*.spec.*', '**/*.test.*', '**/playwright.config.*'],
  });
  return files.some((file) => {
    const content = fs.readFileSync(path.resolve(dirPath, file), 'utf8');
    return /\bfrom\s+['"]playwright['"]|\bimport\s*\(\s*['"]playwright['"]\s*\)|\brequire\s*\(\s*['"]playwright['"]\s*\)/u.test(
      content
    );
  });
}

async function fetchRepoInfo(dirPath: string, packageJson: PackageJson): Promise<Record<string, unknown> | undefined> {
  const git = simpleGit(dirPath);
  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r) => r.name === 'origin');
  const remoteUrl = origin?.refs.fetch ?? origin?.refs.push;
  if (typeof remoteUrl === 'string') {
    const json = await requestRepoInfo(remoteUrl);
    if (json) return json;
  }

  const url = typeof packageJson.repository === 'string' ? packageJson.repository : packageJson.repository?.url;
  if (url) {
    const json = await requestRepoInfo(url);
    if (json && json.message !== 'Not Found') return json;
  }
}

async function requestRepoInfo(urlOrFullName: string): Promise<Record<string, unknown> | undefined> {
  const [org, name] = gitHubUtil.getOrgAndName(urlOrFullName);
  if (!org || !name) return;

  try {
    // Metadata permission
    const response = await getOctokit().request('GET /repos/{owner}/{repo}', {
      owner: org,
      repo: name,
    });
    return response.data;
  } catch (error) {
    const redirectedFullName = getRedirectedRepoFullName(error);
    if (redirectedFullName) {
      return { full_name: redirectedFullName };
    }
  }
}

function getRedirectedRepoFullName(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return;

  const response =
    'response' in error
      ? (error as { response?: { status?: number; headers?: Record<string, string | undefined> } }).response
      : undefined;
  const status = response?.status ?? (error as { status?: number }).status;
  if (status !== 301 && status !== 302) return;

  const location = response?.headers?.location;
  if (typeof location !== 'string') return;

  const [org, name] = gitHubUtil.getOrgAndName(location);
  if (!org || !name) return;

  return `${org}/${name}`;
}
