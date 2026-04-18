import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import fg from 'fast-glob';
import { simpleGit } from 'simple-git';
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
  isBun: boolean;
  isEsmPackage: boolean;
  isWillBoosterConfigs: boolean;
  // dependency information
  doesContainSubPackageJsons: boolean;
  doesContainDockerfile: boolean;
  doesContainGemfile: boolean;
  doesContainGoMod: boolean;
  doesContainPackageJson: boolean;
  doesContainPoetryLock: boolean;
  doesContainUvLock: boolean;
  doesContainPomXml: boolean;
  doesContainPubspecYaml: boolean;
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

  hasStartTestServer: boolean;

  depending: {
    blitz: boolean;
    firebase: boolean;
    genI18nTs: boolean;
    litestream: boolean;
    next: boolean;
    playwrightTest: boolean;
    prisma: boolean;
    pyright: boolean;
    react: boolean;
    reactNative: boolean;
    semanticRelease: boolean;
    storybook: boolean;
    wb: boolean;
  };
  release: {
    branches: string[];
    github: boolean;
    npm: boolean;
  };
  hasVersionSettings: boolean;
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
      isBun: rootConfig?.isBun || fs.existsSync(path.join(dirPath, 'bun.lock')),
      isEsmPackage: esmPackage,
      isWillBoosterConfigs: packageJsonPath.includes('/willbooster-configs'),
      doesContainSubPackageJsons: containsAny('packages/**/package.json', dirPath),
      doesContainDockerfile: !!dockerfile || fs.existsSync(path.resolve(dirPath, 'docker-compose.yml')),
      doesContainGemfile: fs.existsSync(path.resolve(dirPath, 'Gemfile')),
      doesContainGoMod: fs.existsSync(path.resolve(dirPath, 'go.mod')),
      doesContainPackageJson: fs.existsSync(path.resolve(dirPath, 'package.json')),
      doesContainPoetryLock: fs.existsSync(path.resolve(dirPath, 'poetry.lock')),
      doesContainUvLock: fs.existsSync(path.resolve(dirPath, 'uv.lock')),
      doesContainPomXml: fs.existsSync(path.resolve(dirPath, 'pom.xml')),
      doesContainPubspecYaml: fs.existsSync(path.resolve(dirPath, 'pubspec.yaml')),
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
      hasStartTestServer: !!packageJson.scripts?.['start-test-server'],
      depending: {
        blitz: !!dependencies.blitz,
        firebase: !!devDependencies['firebase-tools'],
        genI18nTs: !!dependencies['gen-i18n-ts'] || !!devDependencies['gen-i18n-ts'],
        litestream: dockerfile.includes('install-litestream.sh'),
        react: !!dependencies.react,
        next: !!dependencies.next,
        playwrightTest:
          !!dependencies['@playwright/test'] || !!devDependencies['@playwright/test'] || !!devDependencies.playwright,
        prisma: !!dependencies['@prisma/client'] || !!devDependencies.prisma,
        pyright: !!devDependencies.pyright,
        reactNative: !!dependencies['react-native'],
        semanticRelease: !!(
          devDependencies['semantic-release'] ||
          releaseBranches.length > 0 ||
          releasePlugins.length > 0
        ),
        storybook: !!devDependencies['@storybook/react'],
        wb: !!dependencies['@willbooster/wb'] || !!devDependencies['@willbooster/wb'],
      },
      release: {
        branches: releaseBranches,
        github: releasePlugins.includes('@semantic-release/github'),
        npm: releasePlugins.includes('@semantic-release/npm'),
      },
      hasVersionSettings,
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

function containsAny(pattern: string, dirPath: string): boolean {
  return fg.globSync(pattern, { dot: true, cwd: dirPath, ignore: globIgnore }).length > 0;
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

  const ret = { full_name: `${org}/${name}` };
  try {
    // Metadata permission
    const response = await getOctokit().request('GET /repos/{owner}/{repo}', {
      owner: org,
      repo: name,
    });
    Object.assign(ret, response.data);
  } catch (error) {
    const redirectedFullName = getRedirectedRepoFullName(error);
    if (redirectedFullName) {
      ret.full_name = redirectedFullName;
    }
  }
  return ret;
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
