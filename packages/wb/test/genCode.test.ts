import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getGenCodeScripts } from '../src/commands/genCode.js';
import { Project } from '../src/project.js';

describe('getGenCodeScripts', () => {
  it('runs the project gen-i18n-ts script when it exists', async () => {
    const dirPath = await createProject({
      scripts: {
        'gen-i18n-ts': 'gen-i18n-ts -i locales -o src/i18n.ts -d en-US',
      },
    });

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false))).toContain('YARN run gen-i18n-ts');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('runs the default gen-i18n-ts command when the package and i18n directory exist', async () => {
    const dirPath = await createProject({
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
    });
    await fs.mkdir(path.join(dirPath, 'i18n'));

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false))).toContain(
        'YARN gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP'
      );
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('does not run the default gen-i18n-ts command without an i18n directory', async () => {
    const dirPath = await createProject({
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
    });

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false))).not.toContain(
        'YARN gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP'
      );
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });
});

async function createProject(packageJson: Record<string, unknown>): Promise<string> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-gen-code-'));
  await fs.writeFile(path.join(dirPath, 'package.json'), JSON.stringify(packageJson));
  return dirPath;
}
