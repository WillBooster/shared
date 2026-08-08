import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLitestreamConfig, selectLitestreamConfigProjects } from '../../src/commands/prisma.js';
import type { Project } from '../../src/project.js';

function fakePrismaProject(dirPath: string): Project {
  return { dirPath, prismaDirName: 'prisma', env: {} } as unknown as Project;
}

describe('selectLitestreamConfigProjects', () => {
  it('keeps a single candidate as-is', () => {
    const candidates = [{ project: fakePrismaProject('/repo'), orm: 'prisma' as const }];
    expect(selectLitestreamConfigProjects(candidates)).toEqual(candidates);
  });

  it('picks one project when all candidates resolve to the same database file', () => {
    // At a monorepo root, the root project and a workspace can share one root-level database.
    const candidates = [
      { project: fakePrismaProject('/repo'), orm: 'prisma' as const },
      { project: fakePrismaProject('/repo'), orm: 'prisma' as const },
    ];
    expect(selectLitestreamConfigProjects(candidates)).toHaveLength(1);
  });

  it('rejects candidates with genuinely different database files', () => {
    const candidates = [
      { project: fakePrismaProject('/repo/packages/a'), orm: 'prisma' as const },
      { project: fakePrismaProject('/repo/packages/b'), orm: 'prisma' as const },
    ];
    expect(() => selectLitestreamConfigProjects(candidates)).toThrow(/multiple projects/);
  });
});

describe('createLitestreamConfig with --env-refs', () => {
  it('writes ${VAR} placeholders without requiring the credentials in the environment', () => {
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

  it('still requires the credentials without --env-refs', () => {
    expect(() => createLitestreamConfig(fakePrismaProject('/repo'), 'prisma', '/tmp/unused.yml')).toThrow(
      /Missing environment variables/
    );
  });
});
