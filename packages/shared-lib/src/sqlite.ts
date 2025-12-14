export function getConnectionLevelSqlitePragmas(): string {
  // cf. https://github.com/benbjohnson/litestream/issues/724#issue-3367254318
  return 'PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 10000;';
}

export function getPersistentSqlitePragmas(): string {
  return 'PRAGMA journal_mode = WAL;';
}
