import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '../../src/project.js';
import { prismaScripts } from '../../src/scripts/prismaScripts.js';

const createdDirs: string[] = [];

afterEach(() => {
  for (const dirPath of createdDirs.splice(0)) {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
});

describe('prismaScripts.reset', () => {
  it('truncates WAL through Prisma command and removes sqlite files', async () => {
    const dirPath = createProjectDir();
    installPrisma(dirPath);

    const dbRelativePath = path.join('mount', 'prod.sqlite3');
    const absoluteDbPath = path.resolve(dirPath, 'prisma', dbRelativePath);
    fs.mkdirSync(path.dirname(absoluteDbPath), { recursive: true });

    const { keeper } = await createDatabaseWithWal(absoluteDbPath);
    expect(fs.existsSync(`${absoluteDbPath}-wal`)).toBe(true);
    expect(fs.existsSync(`${absoluteDbPath}-shm`)).toBe(true);
    expect(fs.statSync(`${absoluteDbPath}-wal`).size).toBeGreaterThan(0);

    const project = {
      dirPath,
      env: { DATABASE_URL: `file:${dbRelativePath}` },
      packageJson: { dependencies: {} },
    } as unknown as Project;

    const resetCommand = prismaScripts.reset(project);
    const cleanupCommand = resetCommand.replace(/\s*&&\s*PRISMA migrate reset --force$/, '');

    child_process.execSync(cleanupCommand.replaceAll('PRISMA ', 'yarn prisma '), {
      cwd: dirPath,
      stdio: 'inherit',
    });
    const walPath = `${absoluteDbPath}-wal`;
    if (fs.existsSync(walPath)) {
      expect(fs.statSync(walPath).size).toBe(0);
    }
    keeper.close();

    expect(fs.existsSync(absoluteDbPath)).toBe(false);
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
});

function createProjectDir(): string {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-prisma-scripts-'));
  createdDirs.push(dirPath);
  fs.mkdirSync(path.join(dirPath, 'prisma'), { recursive: true });
  fs.writeFileSync(
    path.join(dirPath, 'package.json'),
    JSON.stringify({ name: 'tmp-prisma-test', private: true, devDependencies: { prisma: '6.10.1' } }, undefined, 2)
  );
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

function installPrisma(dirPath: string): void {
  child_process.execSync('yarn install', { cwd: dirPath, stdio: 'inherit' });
}

async function createDatabaseWithWal(dbPath: string): Promise<{ keeper: DatabaseLike }> {
  const sqliteModuleName = 'node:sqlite';
  const { DatabaseSync } = (await import(sqliteModuleName)) as { DatabaseSync: new (path: string) => DatabaseLike };
  const writer = new DatabaseSync(dbPath);
  writer.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY); INSERT INTO t DEFAULT VALUES;'
  );
  const keeper = new DatabaseSync(dbPath);
  keeper.prepare('SELECT 1').get();
  writer.exec('INSERT INTO t DEFAULT VALUES;');
  writer.close();
  return { keeper };
}

interface DatabaseLike {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): { get(): unknown };
}
