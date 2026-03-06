import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '../../src/project.js';
import { cleanUpSqliteDbIfNeeded, prismaScripts } from '../../src/scripts/prismaScripts.js';

const createdDirs: string[] = [];

afterEach(() => {
  for (const dirPath of createdDirs.splice(0)) {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
});

describe('prismaScripts.reset', () => {
  it('removes sqlite db and sidecar files', () => {
    const dirPath = createProjectDir();

    const dbRelativePath = path.join('mount', 'prod.sqlite3');
    const absoluteDbPath = path.resolve(dirPath, 'prisma', dbRelativePath);
    fs.mkdirSync(path.dirname(absoluteDbPath), { recursive: true });

    createDatabaseWithWal(absoluteDbPath);
    expect(fs.existsSync(`${absoluteDbPath}-wal`)).toBe(true);
    expect(fs.existsSync(`${absoluteDbPath}-shm`)).toBe(true);
    expect(fs.statSync(`${absoluteDbPath}-wal`).size).toBeGreaterThan(0);

    const project = {
      dirPath,
      env: { DATABASE_URL: `file:${dbRelativePath}` },
      packageJson: { dependencies: {} },
    } as unknown as Project;

    const cleanupCommand = cleanUpSqliteDbIfNeeded(project);
    expect(cleanupCommand).toBeTruthy();
    if (!cleanupCommand) throw new Error('cleanup command was not generated');
    expect(cleanupCommand).not.toContain('wal_checkpoint');
    expect(cleanupCommand).toContain(`${absoluteDbPath}-wal`);
    expect(cleanupCommand).toContain(`${absoluteDbPath}-shm`);

    child_process.execSync(cleanupCommand, { cwd: dirPath, stdio: 'inherit' });
    const walPath = `${absoluteDbPath}-wal`;
    expect(fs.existsSync(walPath)).toBe(false);
    expect(fs.existsSync(absoluteDbPath)).toBe(false);
    expect(fs.existsSync(`${absoluteDbPath}-shm`)).toBe(false);
  }, 120_000);

  it('does not add sqlite cleanup when DATABASE_URL is not file scheme', () => {
    const project = {
      dirPath: '/tmp/dummy',
      env: { DATABASE_URL: 'postgresql://localhost:5432/db' },
      packageJson: { dependencies: {} },
    } as unknown as Project;

    const command = prismaScripts.reset(project);
    expect(command).toBe('PRISMA migrate reset --force');
  });

  it('uses wal checkpoint in cleanUpLitestream command and executes without mocks', () => {
    const dirPath = createProjectDir();
    const dbPath = path.resolve(dirPath, 'prisma', 'mount', 'prod.sqlite3');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = createDatabaseWithWal(dbPath);
    fs.writeFileSync(`${dbPath}.tmp`, 'tmp');
    fs.writeFileSync(`${dbPath}-litestream`, 'tmp');
    fs.writeFileSync(path.resolve(dirPath, 'prisma', 'mount', '.prod.sqlite3-shadow'), 'tmp');

    const project = {
      dirPath,
      env: {},
      packageJson: { dependencies: {} },
    } as unknown as Project;
    const command = prismaScripts.cleanUpLitestream(project);

    expect(command).toContain('wal_checkpoint(TRUNCATE)');
    expect(command).not.toContain('/prod.sqlite3*;');
    expect(command).toContain('rm -f "prisma/mount/prod.sqlite3".* "prisma/mount/prod.sqlite3"-*');

    child_process.execSync(command.replaceAll('PRISMA ', 'npx --yes prisma@6.10.1 '), {
      cwd: dirPath,
      stdio: 'inherit',
    });

    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    expect(fs.existsSync(`${dbPath}.tmp`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-litestream`)).toBe(false);
    expect(fs.existsSync(path.resolve(dirPath, 'prisma', 'mount', '.prod.sqlite3-shadow'))).toBe(false);

    const result = db.prepare('SELECT COUNT(*) AS count FROM t').get() as { count: number } | undefined;
    expect(result?.count).toBe(1);
    db.close();
  }, 120_000);

  it('uses wal checkpoint in deployForce cleanup command', () => {
    const project = {
      dirPath: '/tmp/dummy',
      env: {},
      packageJson: { dependencies: {} },
    } as unknown as Project;

    const command = prismaScripts.deployForce(project);
    expect(command).toContain('wal_checkpoint(TRUNCATE)');
    expect(command).not.toContain('/prod.sqlite3*;');
  });
});

function createProjectDir(): string {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-prisma-scripts-'));
  createdDirs.push(dirPath);
  fs.mkdirSync(path.join(dirPath, 'prisma'), { recursive: true });
  fs.writeFileSync(
    path.join(dirPath, 'prisma', 'schema.prisma'),
    [
      'datasource db {',
      '  provider = "sqlite"',
      '  url      = env("DATABASE_URL")',
      '}',
      '',
      'generator client {',
      '  provider = "prisma-client-js"',
      '}',
      '',
    ].join('\n')
  );
  return dirPath;
}

function createDatabaseWithWal(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY);');
  db.exec('INSERT INTO t DEFAULT VALUES;');
  return db;
}
