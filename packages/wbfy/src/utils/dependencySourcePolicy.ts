import path from 'node:path';

import type { PackageConfig } from '../packageConfig.js';

const dependencySectionKeys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const allowedGitHubOrganizationPattern = String.raw`(?:WillBooster|WillBoosterLab)`;
const allowedGitDependencyPatterns = [
  new RegExp(`^${allowedGitHubOrganizationPattern}/[^#\\s]+(?:#\\S+)?$`, 'u'),
  new RegExp(`^github:${allowedGitHubOrganizationPattern}/[^#\\s]+(?:#\\S+)?$`, 'u'),
  new RegExp(
    `^(?:git\\+)?https://github\\.com/${allowedGitHubOrganizationPattern}/[^#\\s]+(?:\\.git)?(?:#\\S+)?$`,
    'u'
  ),
  new RegExp(
    `^(?:git\\+)?ssh://git@github\\.com[:/]${allowedGitHubOrganizationPattern}/[^#\\s]+(?:\\.git)?(?:#\\S+)?$`,
    'u'
  ),
  new RegExp(`^(?:git\\+)?git@github\\.com:${allowedGitHubOrganizationPattern}/[^#\\s]+(?:\\.git)?(?:#\\S+)?$`, 'u'),
];

interface DisallowedDependencySource {
  dependencyName: string;
  dirPath: string;
  sectionName: (typeof dependencySectionKeys)[number];
  specifier: string;
}

export function assertSafeDependencySources(configs: PackageConfig[]): void {
  const disallowedSources = configs.flatMap(getDisallowedDependencySources);
  if (disallowedSources.length === 0) return;

  const details = disallowedSources
    .map(
      ({ dependencyName, dirPath, sectionName, specifier }) =>
        `- ${path.join(dirPath, 'package.json')}: ${sectionName}.${dependencyName} uses ${specifier}`
    )
    .join('\n');

  throw new Error(
    `Disallowed Git dependency sources found.\nOnly WillBooster and WillBoosterLab GitHub dependencies are allowed.\n${details}`
  );
}

function getDisallowedDependencySources(config: PackageConfig): DisallowedDependencySource[] {
  const packageJson = config.packageJson;
  if (!packageJson) return [];

  const disallowedSources: DisallowedDependencySource[] = [];
  for (const sectionName of dependencySectionKeys) {
    const section = packageJson[sectionName];
    if (!section) continue;

    for (const [dependencyName, specifier] of Object.entries(section)) {
      if (!specifier) continue;
      if (!isGitDependencySpecifier(specifier)) continue;
      if (isAllowedGitDependencySpecifier(specifier)) continue;

      disallowedSources.push({
        dependencyName,
        dirPath: config.dirPath,
        sectionName,
        specifier,
      });
    }
  }
  return disallowedSources;
}

function isGitDependencySpecifier(specifier: string): boolean {
  return (
    isGitHubShorthandSpecifier(specifier) ||
    /^(?:bitbucket|gist|github|gitlab):/u.test(specifier) ||
    /^https?:\/\/(?:bitbucket\.org|github\.com|gitlab\.com)\//u.test(specifier) ||
    /^(?:https?|ssh):\/\/\S+\.git(?:#\S+)?$/u.test(specifier) ||
    /^[^@\s]+@[^:\s]+:\S+(?:#\S+)?$/u.test(specifier) ||
    specifier.startsWith('git:') ||
    specifier.startsWith('git+') ||
    specifier.startsWith('ssh://git@')
  );
}

function isGitHubShorthandSpecifier(specifier: string): boolean {
  return /^[a-zA-Z0-9][\w.-]*\/[\w.-]+(?:#\S+)?$/u.test(specifier);
}

function isAllowedGitDependencySpecifier(specifier: string): boolean {
  return allowedGitDependencyPatterns.some((pattern) => pattern.test(specifier));
}
