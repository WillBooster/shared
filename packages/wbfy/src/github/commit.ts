import { spawnSyncAndReturnStdout } from '../utils/spawnUtil.js';

export function getLatestCommitHash(organization: string, repo: string): Promise<string> {
  try {
    const repoUrl = `git@github.com:${organization}/${repo}.git`;
    const output = spawnSyncAndReturnStdout('git', ['ls-remote', repoUrl, 'HEAD'], process.cwd());
    const commitHash = output.split(/\s+/)[0];
    if (!commitHash) {
      throw new Error(`No commits found for ${organization}/${repo}`);
    }
    return Promise.resolve(commitHash);
  } catch (error) {
    return Promise.reject(new Error(`Failed to fetch commits for ${organization}/${repo}: ${String(error)}`));
  }
}
