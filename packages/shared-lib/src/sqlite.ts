export interface SqlitePragmaExecutor {
  exec(sql: string): unknown;
}

export interface RunSqlitePragmasOptions {
  ignoreBusy?: boolean;
}

export function runConnectionLevelSqlitePragmas(executor: SqlitePragmaExecutor): void {
  runSqlitePragmas(executor, getConnectionLevelSqlitePragmas());
}

export function runPersistentSqlitePragmas(
  executor: SqlitePragmaExecutor,
  options: RunSqlitePragmasOptions = {}
): void {
  runSqlitePragmas(executor, getPersistentSqlitePragmas(), options);
}

export function runSqlitePragmas(
  executor: SqlitePragmaExecutor,
  pragmas: string,
  options: RunSqlitePragmasOptions = {}
): void {
  try {
    executor.exec(pragmas);
  } catch (error) {
    if (options.ignoreBusy && isSqliteBusyError(error)) return;
    throw error;
  }
}

export function getConnectionLevelSqlitePragmas(): string {
  // cf. https://github.com/benbjohnson/litestream/issues/724#issue-3367254318
  // cf. https://github.com/benbjohnson/litestream/blob/9bd72348b7e7b1b3b8cf1e8befbee3b2c17444f7/.claude/agents/performance-optimizer.md?plain=1#L225-L232
  return 'PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA cache_size = -16000; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 10000;';
}

export function getPersistentSqlitePragmas(): string {
  return 'PRAGMA journal_mode = WAL;';
}

function isSqliteBusyError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'SQLITE_BUSY';
}
