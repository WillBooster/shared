import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Project } from '../../src/project.js';
import { drizzleScripts } from '../../src/scripts/drizzleScripts.js';

describe('drizzleScripts Litestream commands', () => {
  it('lists backups for file DATABASE_URL databases', () => {
    const project = createDrizzleProject();

    const command = drizzleScripts.listBackups(project);

    expect(command).toBe(
      `litestream ltx -config ./litestream.yml "${path.join(project.rootDirPath, 'drizzle/mount/prod.sqlite3')}"`
    );
  });

  it('restores backups to the requested output path', () => {
    const project = createDrizzleProject();

    const command = drizzleScripts.restore(project, '/tmp/restored.sqlite3');

    expect(command).toBe(
      `rm -f "/tmp/restored.sqlite3" "/tmp/restored.sqlite3-wal" "/tmp/restored.sqlite3-shm"; litestream restore -config ./litestream.yml -o "/tmp/restored.sqlite3" "${path.join(project.rootDirPath, 'drizzle/mount/prod.sqlite3')}"`
    );
  });

  it('requires a file DATABASE_URL for backup operations', () => {
    const project = createDrizzleProject({ DATABASE_URL: 'postgresql://localhost:5432/db' });

    expect(() => drizzleScripts.listBackups(project)).toThrow(
      'wb db list-backups supports Drizzle only when file: DATABASE_URL is set.'
    );
    expect(() => drizzleScripts.restore(project, '/tmp/restored.sqlite3')).toThrow(
      'wb db restore supports Drizzle only when file: DATABASE_URL is set.'
    );
  });
});

function createDrizzleProject(env?: Record<string, string>): Project {
  return {
    dirPath: '/repo/packages/server',
    env: env ?? { DATABASE_URL: 'file:./drizzle/mount/prod.sqlite3' },
    packageJson: { dependencies: {} },
    rootDirPath: '/repo',
  } as unknown as Project;
}
