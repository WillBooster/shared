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
