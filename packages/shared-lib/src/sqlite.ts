export function getConnectionLevelSqlitePragmas(): string {
  // cf. https://github.com/benbjohnson/litestream/issues/724#issue-3367254318
  // cf. https://github.com/benbjohnson/litestream/blob/9bd72348b7e7b1b3b8cf1e8befbee3b2c17444f7/.claude/agents/performance-optimizer.md?plain=1#L225-L232
  return 'PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA cache_size = -16000; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 10000;';
}

export function getPersistentSqlitePragmas(): string {
  return 'PRAGMA journal_mode = WAL;';
}

/**
 * Escapes `%`, `_`, and `\` so that `LIKE` does not read them as wildcards or escapes. SQLite's `LIKE` still matches
 * ASCII letters case-insensitively unless `PRAGMA case_sensitive_like = ON`; use `=` when case must match exactly.
 * The query must declare the escape character, e.g. `WHERE name LIKE ? ESCAPE '\'` in SQL, which is `ESCAPE '\\'`
 * inside a JavaScript string literal.
 */
export function escapeLikePattern(text: string): string {
  return text.replaceAll(/[%\\_]/gu, String.raw`\$&`);
}
