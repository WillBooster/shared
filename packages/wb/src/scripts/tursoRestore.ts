import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

import { spawnAsync } from '@willbooster/shared-lib-node/src';

const TURSO_DATABASE_PROTOCOLS = new Set(['libsql:', 'turso:']);

interface RestoreTursoDatabaseOptions {
  authToken: string | undefined;
  databaseUrl: string;
  outputPath: string;
}

export function isTursoDatabaseUrl(databaseUrl: string | undefined): databaseUrl is string {
  if (!databaseUrl) return false;

  try {
    return TURSO_DATABASE_PROTOCOLS.has(new URL(databaseUrl).protocol);
  } catch {
    return false;
  }
}

export async function restoreTursoDatabase({
  authToken,
  databaseUrl,
  outputPath,
}: RestoreTursoDatabaseOptions): Promise<void> {
  if (!authToken) throw new Error('DATABASE_AUTH_TOKEN is required to restore a Turso database.');

  const absoluteOutputPath = path.resolve(outputPath);
  const temporaryOutputPath = path.join(
    path.dirname(absoluteOutputPath),
    `.${path.basename(absoluteOutputPath)}.${crypto.randomUUID()}.tmp`
  );
  await fs.promises.mkdir(path.dirname(absoluteOutputPath), { recursive: true });

  try {
    const response = await fetch(getTursoDumpUrl(databaseUrl), {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!response.ok) {
      throw new Error(`Turso dump request failed with HTTP ${response.status} ${response.statusText}.`);
    }
    if (!response.body) throw new Error('Turso dump response has no body.');

    await importDump(response.body, temporaryOutputPath);
    await validateSqliteDatabase(temporaryOutputPath);
    await removeSqliteSidecarFiles(absoluteOutputPath);
    await fs.promises.rename(temporaryOutputPath, absoluteOutputPath);
  } finally {
    await removeSqliteFiles(temporaryOutputPath);
  }
}

function getTursoDumpUrl(databaseUrl: string): URL {
  const url = new URL(databaseUrl);
  if (url.protocol === 'libsql:' || url.protocol === 'turso:') url.protocol = 'https:';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported Turso database URL protocol: ${url.protocol}`);
  }
  url.pathname = `${url.pathname.replace(/\/$/u, '')}/dump`;
  url.search = '';
  url.hash = '';
  return url;
}

async function importDump(dump: ReadableStream<Uint8Array>, outputPath: string): Promise<void> {
  const sqlite = childProcess.spawn('sqlite3', [outputPath], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  sqlite.stderr.setEncoding('utf8');
  sqlite.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const completion = new Promise<void>((resolve, reject) => {
    sqlite.once('error', (error) => {
      reject(new Error('Failed to start sqlite3, which is required to restore a Turso database.', { cause: error }));
    });
    sqlite.once('close', (exitCode) => {
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new Error(`sqlite3 failed to import the Turso dump${stderr.trim() ? `: ${stderr.trim()}` : '.'}`));
      }
    });
  });

  const [pipeResult, completionResult] = await Promise.allSettled([
    dump.pipeTo(Writable.toWeb(sqlite.stdin)).catch((error: unknown) => {
      sqlite.kill();
      throw error;
    }),
    completion,
  ]);
  if (completionResult.status === 'rejected') throw completionResult.reason;
  if (pipeResult.status === 'rejected') throw pipeResult.reason;
}

async function validateSqliteDatabase(databasePath: string): Promise<void> {
  const result = await spawnAsync('sqlite3', [databasePath], {
    input: 'PRAGMA quick_check;',
    stdio: 'pipe',
  });
  if (result.status !== 0 || result.stdout.trim() !== 'ok') {
    throw new Error(`Restored SQLite database failed quick_check: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

async function removeSqliteFiles(databasePath: string): Promise<void> {
  await Promise.all([fs.promises.rm(databasePath, { force: true }), removeSqliteSidecarFiles(databasePath)]);
}

async function removeSqliteSidecarFiles(databasePath: string): Promise<void> {
  await Promise.all(
    ['-journal', '-wal', '-shm'].map(async (suffix) => fs.promises.rm(`${databasePath}${suffix}`, { force: true }))
  );
}
