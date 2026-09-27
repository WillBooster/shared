/**
 * Parses a GitHub repository full name such as `WillBooster/shared`. Returns undefined unless the owner consists of
 * alphanumerics and hyphens and the repository name of alphanumerics, `-`, `_`, and `.` other than `.` and `..`.
 */
export function parseGitHubRepositoryFullName(fullName: string): { owner: string; repo: string } | undefined {
  const match = /^([\dA-Za-z-]+)\/([\w.-]+)$/u.exec(fullName);
  if (!match) return undefined;
  const [, owner, repo] = match as unknown as [string, string, string];
  return repo === '.' || repo === '..' ? undefined : { owner, repo };
}
