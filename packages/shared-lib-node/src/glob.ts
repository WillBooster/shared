import fg from 'fast-glob';

import { spawnAsync } from './spawn.js';

export const globIgnore = [
  '**/node_modules/**',
  '**/.antigravitycli/**',
  // Git's object store holds copies of tracked files (and `dot: true` makes them visible), so
  // scanning it would both slow every glob down and let stale blobs influence detection.
  '**/.git/**',
  // The org-standard temporary directory; stale copies under it (e.g. review scratch dirs) must
  // not influence language detection.
  '**/.tmp/**',
  '**/.tmp-*/**',
  // Local caches can contain complete third-party source checkouts. Treating those as repository
  // code generates workflows for paths that are gitignored and absent from fresh CI checkouts.
  '**/.cache/**',
  '**/.venv/**',
  '**/test-fixtures/**',
  '**/test/fixtures/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/temp/**',
  '**/tmp/**',
];

/**
 * Returns fast-glob `ignore` patterns for globbing in `dirPath`: {@link globIgnore} plus every
 * untracked path that Git ignores there (e.g. third-party repositories cloned into a gitignored
 * directory), so that the matches reflect only the repository's own files.
 */
export async function getGlobIgnore(dirPath: string): Promise<string[]> {
  return [...globIgnore, ...(await getGitIgnorePatterns(dirPath))];
}

async function getGitIgnorePatterns(dirPath: string): Promise<string[]> {
  // `LC_ALL=C` keeps Git's messages untranslated for the check below.
  const options = { cwd: dirPath, env: { ...process.env, LC_ALL: 'C' } };
  const revParseResult = await spawnAsync('git', ['rev-parse', '--show-toplevel', '--show-prefix'], options);
  if (revParseResult.stderr.includes('not a git repository')) return [];
  if (revParseResult.status !== 0) {
    throw new Error(`git rev-parse failed in ${dirPath}: ${revParseResult.stderr.trim()}`);
  }
  const [topLevelPath, prefix = ''] = revParseResult.stdout.split('\n');

  // `--directory` lists a wholly ignored, untracked directory (e.g. node_modules) as one `dir/`
  // entry. It runs from the top level because it fails inside such a directory, which then shows up
  // as an entry containing `dirPath`.
  const lsFilesResult = await spawnAsync(
    'git',
    ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
    { ...options, cwd: topLevelPath }
  );
  if (lsFilesResult.status !== 0) {
    throw new Error(`git ls-files failed in ${topLevelPath}: ${lsFilesResult.stderr.trim()}`);
  }
  const ignoredPaths = lsFilesResult.stdout.split('\0').filter(Boolean);
  if (ignoredPaths.some((ignoredPath) => ignoredPath.endsWith('/') && prefix.startsWith(ignoredPath))) return ['**'];
  return ignoredPaths
    .filter((ignoredPath) => ignoredPath.startsWith(prefix))
    .map((ignoredPath) => {
      const escapedPath = fg.escapePath(ignoredPath.slice(prefix.length));
      return ignoredPath.endsWith('/') ? `${escapedPath}**` : escapedPath;
    });
}
