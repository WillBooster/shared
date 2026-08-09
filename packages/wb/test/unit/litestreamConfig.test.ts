import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLitestreamConfig, selectLitestreamConfigProjects } from '../../src/commands/prisma.js';
import type { Project } from '../../src/project.js';

function fakePrismaProject(dirPath: string): Project {
  return { dirPath, prismaDirName: 'prisma', env: {} } as unknown as Project;
}

function fakeDrizzleProject(dirPath: string, env: Record<string, string>): Project {
  return {
    dirPath,
    rootDirPath: '/repo',
    env: { DATABASE_URL: 'file:./drizzle/mount/prod.sqlite3', ...env },
  } as unknown as Project;
}

const credentials = {
  CLOUDFLARE_R2_LITESTREAM_ACCOUNT_ID: 'account',
  CLOUDFLARE_R2_LITESTREAM_BUCKET_NAME: 'bucket',
  CLOUDFLARE_R2_LITESTREAM_ACCESS_KEY_ID: 'access',
  CLOUDFLARE_R2_LITESTREAM_SECRET_ACCESS_KEY: 'secret',
};

describe('selectLitestreamConfigProjects', () => {
  it('keeps a single candidate as-is', () => {
    const candidates = [{ project: fakePrismaProject('/repo'), orm: 'prisma' as const }];
    expect(selectLitestreamConfigProjects(candidates)).toEqual(candidates);
  });

  it('picks one project when all candidates resolve to the same database file and credentials', () => {
    // A Drizzle `file:` URL resolves against the repository root, so the root project and a
    // workspace genuinely collapse to one database.
    const candidates = [
      { project: fakeDrizzleProject('/repo', credentials), orm: 'drizzle' as const },
      { project: fakeDrizzleProject('/repo/packages/server', credentials), orm: 'drizzle' as const },
    ];
    expect(selectLitestreamConfigProjects(candidates)).toEqual(candidates.slice(0, 1));
  });

  it('rejects candidates with genuinely different database files', () => {
    const candidates = [
      { project: fakePrismaProject('/repo/packages/a'), orm: 'prisma' as const },
      { project: fakePrismaProject('/repo/packages/b'), orm: 'prisma' as const },
    ];
    expect(() => selectLitestreamConfigProjects(candidates)).toThrow(/multiple projects/);
  });

  it('rejects same-database candidates whose rendered credentials differ, unless --env-refs', () => {
    const candidates = [
      { project: fakeDrizzleProject('/repo', credentials), orm: 'drizzle' as const },
      {
        project: fakeDrizzleProject('/repo/packages/server', {
          ...credentials,
          CLOUDFLARE_R2_LITESTREAM_BUCKET_NAME: 'other-bucket',
        }),
        orm: 'drizzle' as const,
      },
    ];
    expect(() => selectLitestreamConfigProjects(candidates)).toThrow(/multiple projects/);
    // With --env-refs the rendered config holds only ${VAR} placeholders, so it is identical;
    // the database path comes from the committed plaintext fnox values, not project.env.
    expect(
      selectLitestreamConfigProjects(candidates, true, () => ({ DATABASE_URL: 'file:./drizzle/mount/prod.sqlite3' }))
    ).toHaveLength(1);
  });

  it('propagates a project-specific resolution error instead of silently skipping the project', () => {
    const candidates = [
      { project: fakeDrizzleProject('/repo', credentials), orm: 'drizzle' as const },
      {
        project: { dirPath: '/repo/packages/api', rootDirPath: '/repo', env: {} } as unknown as Project,
        orm: 'drizzle' as const,
      },
    ];
    expect(() => selectLitestreamConfigProjects(candidates)).toThrow(/file: DATABASE_URL/);
  });
});

describe('createLitestreamConfig with --env-refs', () => {
  it('writes ${VAR} placeholders without reading credentials from the environment', () => {
    const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-litestream-')), 'litestream.yml');
    try {
      createLitestreamConfig(fakePrismaProject('/repo'), 'prisma', outputPath, true);
      const content = fs.readFileSync(outputPath, 'utf8');
      expect(content).toContain('endpoint: https://${CLOUDFLARE_R2_LITESTREAM_ACCOUNT_ID}.r2.cloudflarestorage.com');
      expect(content).toContain('bucket: ${CLOUDFLARE_R2_LITESTREAM_BUCKET_NAME}');
      expect(content).toContain('access-key-id: ${CLOUDFLARE_R2_LITESTREAM_ACCESS_KEY_ID}');
      expect(content).toContain('secret-access-key: ${CLOUDFLARE_R2_LITESTREAM_SECRET_ACCESS_KEY}');
      expect(content).toContain('path: prisma/mount/prod.sqlite3');
    } finally {
      fs.rmSync(path.dirname(outputPath), { recursive: true, force: true });
    }
  });

  it('resolves the Drizzle database path from the provided plaintext values, not project.env', () => {
    const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-litestream-')), 'litestream.yml');
    try {
      const project = { dirPath: '/repo', rootDirPath: '/repo', env: {} } as unknown as Project;
      createLitestreamConfig(project, 'drizzle', outputPath, true, {
        DATABASE_URL: 'file:./drizzle/mount/prod.sqlite3',
      });
      expect(fs.readFileSync(outputPath, 'utf8')).toContain('path: /repo/drizzle/mount/prod.sqlite3');
    } finally {
      fs.rmSync(path.dirname(outputPath), { recursive: true, force: true });
    }
  });

  it('still requires the credentials without --env-refs', () => {
    expect(() => createLitestreamConfig(fakePrismaProject('/repo'), 'prisma', '/tmp/unused.yml')).toThrow(
      /Missing environment variables/
    );
  });
});
