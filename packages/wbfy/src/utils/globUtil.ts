export const globIgnore = [
  '**/node_modules/**',
  '**/.antigravitycli/**',
  // Next projects keep Bun's global virtual store inside the project so Turbopack accepts its
  // symlinks. Package sources in that cache must never influence detection or be rewritten.
  '**/.bun-cache/**',
  // Git's object store holds copies of tracked files (and `dot: true` makes them visible), so
  // scanning it would both slow every glob down and let stale blobs influence detection.
  '**/.git/**',
  // The org-standard temporary directory; stale copies under it (e.g. review scratch dirs) must
  // not influence language detection.
  '**/.tmp/**',
  '**/.tmp-*/**',
  '**/.venv/**',
  '**/test-fixtures/**',
  '**/test/fixtures/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/temp/**',
  '**/tmp/**',
];
