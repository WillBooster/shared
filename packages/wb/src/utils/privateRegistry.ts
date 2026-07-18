import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Materialization of `@willbooster-private/*` registry (Verdaccio) dependencies for Docker builds:
 * the packages are downloaded on the host (auth via .npmrc / ~/.npmrc locally, or VERDACCIO_TOKEN
 * on CI) and extracted next to the repository so image builds need no registry credentials
 * (https://github.com/WillBooster/shared/issues/964).
 */
export const PRIVATE_REGISTRY_SCOPE = '@willbooster-private';

// `git:`/`git+`/`git@` (not the bare word `git`): npm allows arbitrary dist-tags, so a tag named
// `git` or `git-next` must still be treated as a registry specifier.
const nonRegistrySpecifierPrefixes = [
  'git:',
  'git+',
  'git@',
  'file:',
  'link:',
  'workspace:',
  'http:',
  'https:',
  'portal:',
  'patch:',
];

// The single source of truth for which git specifiers the private-package tooling supports:
// `wb setup-private-packages` materializes exactly these, and `wb optimizeForDockerBuild` must
// rewrite exactly these (rewriting other orgs' SSH URLs would point at never-materialized paths).
const privateGitDependencyPattern = /^git@github\.com:(?:WillBooster|WillBoosterLab)\/[^/#]+(?:\.git)?(?:#.*)?$/;

// Returns boolean (not a `value is string` predicate): a predicate would narrow the negative
// branch to `undefined` and break `else if` chains over `string | undefined` dependency values.
export function isPrivateGitDependency(value: unknown): boolean {
  return typeof value === 'string' && privateGitDependencyPattern.test(value);
}

export function isPrivateRegistryDependency(name: string, value: unknown): value is string {
  return (
    name.startsWith(`${PRIVATE_REGISTRY_SCOPE}/`) &&
    typeof value === 'string' &&
    !nonRegistrySpecifierPrefixes.some((prefix) => value.startsWith(prefix))
  );
}

export interface PrivateRegistryAuth {
  registryUrl: string;
  authToken: string | undefined;
}

/**
 * Resolve the registry URL and auth token for the private scope from the project's .npmrc and
 * ~/.npmrc (nearer file wins), expanding `${VAR}` references from the environment. On CI the
 * VERDACCIO_TOKEN environment variable serves as the fallback token.
 */
export function resolvePrivateRegistryAuth(rootDirPath: string): PrivateRegistryAuth | undefined {
  const entries: Record<string, string> = {};
  // Reverse order so nearer files overwrite the home-directory defaults.
  for (const npmrcPath of [path.join(os.homedir(), '.npmrc'), path.join(rootDirPath, '.npmrc')]) {
    try {
      Object.assign(entries, parseNpmrc(fs.readFileSync(npmrcPath, 'utf8')));
    } catch {
      // Missing npmrc files are fine; the other file or VERDACCIO_TOKEN may still provide auth.
    }
  }

  const registryUrl = entries[`${PRIVATE_REGISTRY_SCOPE}:registry`]?.replace(/\/+$/, '');
  if (!registryUrl) return;

  // npm-style URI matching: normalize both sides to a trailing slash so a token for
  // `//verdaccio.example.com/` can never match `//verdaccio.example.com-other.org/`, and pick the
  // MOST SPECIFIC (longest) matching prefix so `//host/private/` beats `//host/`.
  const normalizedRegistryUrl = `${registryUrl.replace(/^https?:/, '').replace(/\/+$/, '')}/`;
  let matchedToken: string | undefined;
  let matchedPrefixLength = -1;
  for (const [key, value] of Object.entries(entries)) {
    // Skip empty tokens (an unset `${VAR}` expands to ''): an empty match must not defeat the
    // VERDACCIO_TOKEN fallback below.
    if (!key.endsWith(':_authToken') || !value) continue;
    const prefix = `${key.slice(0, -':_authToken'.length).replace(/\/+$/, '')}/`;
    if (normalizedRegistryUrl.startsWith(prefix) && prefix.length > matchedPrefixLength) {
      matchedPrefixLength = prefix.length;
      matchedToken = value;
    }
  }
  // No Project instance exists at this layer, so process.env is the only source for the
  // CI-injected fallback token.
  const authToken = matchedToken ?? process.env.VERDACCIO_TOKEN;
  return { registryUrl, authToken };
}

export function parseNpmrc(content: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replaceAll(/\$\{([^}]+)\}/g, (_, variableName: string) => process.env[variableName] ?? '');
    entries[key] = value;
  }
  return entries;
}

/**
 * Download and extract one registry package into `targetDirPath`. The version must be an exact
 * semver (the org pins exact versions via bunfig `exact = true`); `latest` and simple `^`/`~`
 * ranges degrade to the range's base version or the registry's latest dist-tag.
 */
export async function downloadAndExtractRegistryPackage(
  auth: PrivateRegistryAuth,
  packageName: string,
  versionSpecifier: string,
  targetDirPath: string
): Promise<void> {
  const version = await resolveVersion(auth, packageName, versionSpecifier);
  const metadata = await fetchRegistryJson<{ dist?: { tarball?: string } }>(
    auth,
    `${auth.registryUrl}/${encodePackageName(packageName)}/${version}`
  );
  const tarballUrl = metadata.dist?.tarball;
  if (!tarballUrl) {
    throw new Error(`No tarball URL for ${packageName}@${version} in ${auth.registryUrl}.`);
  }

  const response = await fetchFromRegistry(auth, tarballUrl);
  const tarballPath = path.join(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wb-private-package-')),
    'package.tgz'
  );
  try {
    await fs.promises.writeFile(tarballPath, Buffer.from(await response.arrayBuffer()));
    await fs.promises.rm(targetDirPath, { force: true, recursive: true });
    await fs.promises.mkdir(targetDirPath, { recursive: true });
    // npm tarballs place the content under a top-level `package/` directory.
    const ret = child_process.spawnSync('tar', ['-xzf', tarballPath, '-C', targetDirPath, '--strip-components=1'], {
      stdio: 'inherit',
    });
    if (ret.status !== 0) {
      throw new Error(`Failed to extract ${packageName}@${version} (${tarballUrl}).`);
    }
  } finally {
    await fs.promises.rm(path.dirname(tarballPath), { force: true, recursive: true });
  }
}

async function resolveVersion(
  auth: PrivateRegistryAuth,
  packageName: string,
  versionSpecifier: string
): Promise<string> {
  // Prerelease and `+build` metadata are both part of valid exact SemVer versions.
  const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(versionSpecifier)
    ? versionSpecifier
    : /^[\^~]\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(versionSpecifier)
      ? // Without a semver resolver, degrade a simple range to its base version (org repos pin
        // exact versions, so this path is a best-effort fallback).
        versionSpecifier.slice(1)
      : undefined;
  if (exactVersion) return exactVersion;

  const packument = await fetchRegistryJson<{ 'dist-tags'?: Record<string, string> }>(
    auth,
    `${auth.registryUrl}/${encodePackageName(packageName)}`
  );
  const distTag = packument['dist-tags']?.[versionSpecifier === '*' ? 'latest' : versionSpecifier];
  if (!distTag) {
    throw new Error(
      `Cannot resolve ${packageName}@${versionSpecifier}; use an exact version, a ^/~ range, or a dist-tag.`
    );
  }
  return distTag;
}

async function fetchRegistryJson<T>(auth: PrivateRegistryAuth, url: string): Promise<T> {
  const response = await fetchFromRegistry(auth, url);
  return (await response.json()) as T;
}

async function fetchFromRegistry(auth: PrivateRegistryAuth, url: string): Promise<Response> {
  // Tarball URLs come from registry-controlled metadata; attach the token only to the configured
  // registry's own origin so a malicious or misconfigured registry cannot redirect the credential
  // to a third-party host.
  const sendAuthToken = !!auth.authToken && isSameOrigin(url, auth.registryUrl);
  const response = await fetch(url, {
    headers: sendAuthToken ? { authorization: `Bearer ${auth.authToken}` } : {},
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response;
}

function isSameOrigin(url: string, registryUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(registryUrl).origin;
  } catch {
    return false;
  }
}

function encodePackageName(packageName: string): string {
  return packageName.replace('/', '%2F');
}
