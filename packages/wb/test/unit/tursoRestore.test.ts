import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { afterEach, describe, expect, it } from 'vitest';

import { isTursoDatabaseUrl, restoreTursoDatabase } from '../../src/scripts/tursoRestore.js';

const temporaryPaths: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    temporaryPaths.splice(0).map(async (temporaryPath) => fs.promises.rm(temporaryPath, { recursive: true }))
  );
});

describe('isTursoDatabaseUrl', () => {
  it('recognizes remote Turso database URLs', () => {
    expect(isTursoDatabaseUrl('libsql://database.example.com')).toBe(true);
    expect(isTursoDatabaseUrl('turso://database.example.com')).toBe(true);
    expect(isTursoDatabaseUrl('file:./db.sqlite3')).toBe(false);
    expect(isTursoDatabaseUrl('postgresql://database.example.com/app')).toBe(false);
  });
});

describe('restoreTursoDatabase', () => {
  it('restores a dump using the database token', async () => {
    const authToken = 'test-database-token';
    const server = await startDumpServer((request, response) => {
      expect(request.url).toBe('/dump');
      expect(request.headers.authorization).toBe(`Bearer ${authToken}`);
      response.end(`PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
INSERT INTO messages VALUES(1, 'restored');
COMMIT;
`);
    });
    const outputPath = await createOutputPath();

    await restoreTursoDatabase({
      authToken,
      databaseUrl: getServerUrl(server),
      outputPath,
    });

    const result = await spawnAsync('sqlite3', [outputPath, 'SELECT body FROM messages;'], { stdio: 'pipe' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('restored');
  });

  it('keeps the previous database when importing the dump fails', async () => {
    const server = await startDumpServer((_request, response) => response.end('INVALID SQL;'));
    const outputPath = await createOutputPath();
    await fs.promises.writeFile(outputPath, 'previous database');

    await expect(
      restoreTursoDatabase({
        authToken: 'test-database-token',
        databaseUrl: getServerUrl(server),
        outputPath,
      })
    ).rejects.toThrow('sqlite3 failed to import the Turso dump');

    expect(await fs.promises.readFile(outputPath, 'utf8')).toBe('previous database');
    const outputDirectoryEntries = await fs.promises.readdir(path.dirname(outputPath));
    expect(outputDirectoryEntries.filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});

async function startDumpServer(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function getServerUrl(server: http.Server): string {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server has no TCP address.');
  return `http://127.0.0.1:${address.port}`;
}

async function createOutputPath(): Promise<string> {
  const directoryPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wb-turso-restore-'));
  temporaryPaths.push(directoryPath);
  return path.join(directoryPath, 'restored.sqlite3');
}
