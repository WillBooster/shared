import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    createDatabaseWithWal(dbPath);

    const project = {
      dirPath,
      env: {},
      packageJson: { dependencies: {} },
    } as unknown as Project;
    const command = prismaScripts.cleanUpLitestream(project);

    expect(command).toContain('wal_checkpoint(TRUNCATE)');
    expect(command).not.toContain('/prod.sqlite3*;');
    const checkpointOnlyCommand = extractCheckpointOnlyCommand(command, 'prisma/mount/prod.sqlite3');
    child_process.execSync(checkpointOnlyCommand.replaceAll('PRISMA ', 'npx --yes prisma@6.10.1 '), {
      cwd: dirPath,
      stdio: 'inherit',
    });
    // If WAL contents are checkpointed into the main DB, deleting WAL should not lose inserted rows.
    child_process.execSync(`rm -f "${dbPath}-wal" "${dbPath}-shm"`, { cwd: dirPath, stdio: 'inherit' });
    const rowCount = child_process
      .execSync(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM t;"`, {
        cwd: dirPath,
        encoding: 'utf8',
      })
      .trim();
    expect(rowCount).toBe('1');

    child_process.execSync(command.replaceAll('PRISMA ', 'npx --yes prisma@6.10.1 '), {
      cwd: dirPath,
      stdio: 'inherit',
    });
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
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

function createDatabaseWithWal(dbPath: string): void {
  const sqlite3Path = child_process.execSync('which sqlite3', { encoding: 'utf8' }).trim();
  const sql = [
    '.dbconfig no_ckpt_on_close on',
    'PRAGMA journal_mode=WAL;',
    'CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY);',
    'INSERT INTO t DEFAULT VALUES;',
  ].join('\n');
  child_process.execSync(`${sqlite3Path} "${dbPath}" <<'SQL'\n${sql}\nSQL`, { stdio: 'inherit' });
}

function extractCheckpointOnlyCommand(command: string, dbRelativePath: string): string {
  const marker = `&& rm -f "${dbRelativePath}"`;
  const markerIndex = command.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Failed to find marker in command: ${marker}`);
  }
  return command.slice(0, markerIndex).trim();
}
