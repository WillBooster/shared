import { spawnAndReturnStdout } from '../utils/spawnUtil.js';

export async function getLatestCommitHash(organization: string, repo: string): Promise<string> {
  const repoUrl = `git@github.com:${organization}/${repo}.git`;
  const output = await spawnAndReturnStdout('git', ['ls-remote', repoUrl, 'HEAD'], process.cwd());
  const commitHash = output.split(/\s+/)[0];
  if (!commitHash) {
    throw new Error(`Failed to fetch commits for ${organization}/${repo}: no commits found`);
  }
  return commitHash;
}
