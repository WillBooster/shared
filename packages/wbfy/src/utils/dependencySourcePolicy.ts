import path from 'node:path';

import type { PackageConfig } from '../packageConfig.js';

const dependencySectionKeys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

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
    `Disallowed Git dependency sources found.\nOnly WillBoosterLab GitHub dependencies are allowed.\n${details}`
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
    specifier.startsWith('github:') ||
    specifier.startsWith('git:') ||
    specifier.startsWith('git+') ||
    specifier.startsWith('ssh://git@') ||
    specifier.startsWith('https://github.com/') ||
    specifier.startsWith('git@github.com:')
  );
}

function isAllowedGitDependencySpecifier(specifier: string): boolean {
  return (
    /^github:WillBoosterLab\/[^#\s]+(?:#\S+)?$/u.test(specifier) ||
    /^(?:git\+)?https:\/\/github\.com\/WillBoosterLab\/[^#\s]+(?:\.git)?(?:#\S+)?$/u.test(specifier) ||
    /^(?:git\+)?ssh:\/\/git@github\.com\/WillBoosterLab\/[^#\s]+(?:\.git)?(?:#\S+)?$/u.test(specifier) ||
    /^git@github\.com:WillBoosterLab\/[^#\s]+(?:\.git)?(?:#\S+)?$/u.test(specifier)
  );
}
