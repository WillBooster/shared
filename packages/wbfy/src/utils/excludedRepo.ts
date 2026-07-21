import path from 'node:path';

import type { PackageConfig } from '../packageConfig.js';

import { gitHubUtil } from './githubUtil.js';

// Repositories deliberately kept off the standard, by GitHub repository name.
const excludedRepoNames = new Set<string>();

/** Whether the repository is on the exclusion list, matched by its GitHub repository name. */
export function isExcludedRepo(rootDirPath: string, packageJson: PackageConfig['packageJson']): boolean {
  const repositoryUrl =
    typeof packageJson?.repository === 'string' ? packageJson.repository : packageJson?.repository?.url;
  // The manifest names the repository canonically; a checkout directory may be renamed freely, so
  // it is only the fallback for a manifest without a repository field.
  const repoName = repositoryUrl
    ? gitHubUtil.getOrgAndName(repositoryUrl)[1]
    : path.basename(path.resolve(rootDirPath));
  return excludedRepoNames.has(repoName);
}
