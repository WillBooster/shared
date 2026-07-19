export const globIgnore = [
  '**/node_modules/**',
  '**/.antigravitycli/**',
  // The org-standard temporary directory; stale copies under it (e.g. review scratch dirs) must
  // not influence language detection.
  '**/.tmp/**',
  '**/.venv/**',
  '**/test-fixtures/**',
  '**/test/fixtures/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/temp/**',
  '**/tmp/**',
];
