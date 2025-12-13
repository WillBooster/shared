export function getConnectionLevelSqlitePragmas(): string {
  return 'PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 0;';
}

export function getPersistentSqlitePragmas(): string {
  return 'PRAGMA journal_mode = WAL;';
}
