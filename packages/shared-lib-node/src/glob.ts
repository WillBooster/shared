import childProcess from 'node:child_process';

import fg from 'fast-glob';

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
export function getGlobIgnore(dirPath: string): string[] {
  return [
    ...globIgnore,
    ...listGitIgnoredPaths(dirPath).map((ignoredPath) =>
      ignoredPath.endsWith('/') ? `${fg.escapePath(ignoredPath)}**` : fg.escapePath(ignoredPath)
    ),
  ];
}

function listGitIgnoredPaths(dirPath: string): string[] {
  // `LC_ALL=C` keeps Git's messages untranslated for the check below.
  const options = { cwd: dirPath, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } } as const;
  const revParseResult = childProcess.spawnSync('git', ['rev-parse', '--show-toplevel', '--show-prefix'], options);
  if (revParseResult.stderr.includes('not a git repository')) return [];
  if (revParseResult.status !== 0) {
    throw new Error(`git rev-parse failed in ${dirPath}: ${revParseResult.stderr.trim()}`);
  }
  const [topLevelPath, prefix] = revParseResult.stdout.split('\n');
  // Git owns no file of a directory that the work tree ignores (e.g. a scratch project under
  // `.tmp/`), and `ls-files --directory` fails inside one. Check it by its path from the top level:
  // `check-ignore .` matches `.` itself against patterns such as `*`, even at the top level.
  if (prefix) {
    const checkIgnoreResult = childProcess.spawnSync('git', ['check-ignore', '-q', prefix.slice(0, -1)], {
      ...options,
      cwd: topLevelPath,
    });
    if (checkIgnoreResult.status === 0) return [];
    if (checkIgnoreResult.status !== 1) {
      throw new Error(`git check-ignore failed in ${dirPath}: ${checkIgnoreResult.stderr.trim()}`);
    }
  }

  // `--directory` lists a wholly ignored directory (e.g. node_modules) as one `dir/` entry, and
  // `dirPath` itself as `./` when every file under it is ignored.
  const ignoredPaths = childProcess
    .execFileSync('git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], {
      ...options,
      maxBuffer: 1024 * 1024 * 1024,
    })
    .split('\0')
    .filter(Boolean);
  return ignoredPaths.includes('./') ? [] : ignoredPaths;
}
