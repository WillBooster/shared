import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getGenCodeScripts } from '../../src/commands/genCode.js';
import { Project } from '../../src/project.js';

describe('getGenCodeScripts', () => {
  it('generates the .dev.vars file, then worker types, before the other generators', async () => {
    const dirPath = await createWorkerProject({ devDependencies: { wrangler: '4.70.0' } }, true);

    try {
      // `wrangler types` reads secret members of `Env` only from .dev.vars (never process.env), so it
      // must be regenerated first; and worker types must precede the later generators because
      // worker-configuration.d.ts is gitignored and they type-check against the `Env` it declares.
      expect(getGenCodeScripts(new Project(dirPath, {}, false), {}).slice(0, 2)).toStrictEqual([
        'YARN wb gen-dev-vars .dev.vars',
        'YARN wrangler types',
      ]);
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('does not generate worker types without an own wrangler dependency', async () => {
    const dirPath = await createWorkerProject({}, true);

    try {
      const scripts = getGenCodeScripts(new Project(dirPath, {}, false), {});
      expect(scripts).not.toContain('YARN wrangler types');
      // .dev.vars is only needed to type `wrangler types`; skip it when worker types aren't generated.
      expect(scripts).not.toContain('YARN wb gen-dev-vars .dev.vars');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('does not generate worker types the project does not consume', async () => {
    // No gitignore entry means wbfy left the package unmanaged because its tsconfig cannot
    // reference the file (e.g. a hand-maintained Env), so generating it would only leave an
    // untracked ~500KB file behind.
    const dirPath = await createWorkerProject({ devDependencies: { wrangler: '4.70.0' } }, false);

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false), {})).not.toContain('YARN wrangler types');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('does not generate worker types when an env-file invocation would be overwritten', async () => {
    // The named file exists, so the project's own invocation infers Env members from it that the bare
    // invocation here would drop.
    const dirPath = await createWorkerProject(
      { devDependencies: { wrangler: '4.70.0' }, scripts: { 'gen-types': 'wrangler types --env-file custom.env' } },
      true
    );
    await fs.writeFile(path.join(dirPath, 'custom.env'), 'API_KEY=\n');

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false), {})).not.toContain('YARN wrangler types');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('generates worker types when the named env file is gone', async () => {
    const dirPath = await createWorkerProject(
      { devDependencies: { wrangler: '4.70.0' }, scripts: { 'gen-types': 'wrangler types --env-file .env' } },
      true
    );

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false), {})).toContain('YARN wrangler types');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it.each([
    ['strict vars', 'wrangler types --check --strict-vars=false'],
    ['a custom output path', 'wrangler types --check --path src/env.d.ts'],
    ['a quoted env file', 'wrangler types --env-file "custom.env"'],
    ['a directory change', 'cd sub && wrangler types'],
  ])('does not generate worker types when a script checks %s', async (_description, script) => {
    const dirPath = await createWorkerProject(
      { devDependencies: { wrangler: '4.70.0' }, scripts: { 'check-types': script } },
      true
    );

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false), {})).not.toContain('YARN wrangler types');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('still generates worker types alongside a plain freshness check', async () => {
    const dirPath = await createWorkerProject(
      { devDependencies: { wrangler: '4.70.0' }, scripts: { 'check-types': 'wrangler types --check' } },
      true
    );

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false), {})).toContain('YARN wrangler types');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('runs the project gen-i18n-ts script when it exists', async () => {
    const dirPath = await createProject({
      scripts: {
        'gen-i18n-ts': 'gen-i18n-ts -i locales -o src/i18n.ts -d en-US',
      },
    });
    await fs.mkdir(path.join(dirPath, 'src'));

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false), {})).toContain('YARN run gen-i18n-ts');
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
    await fs.mkdir(path.join(dirPath, 'src'));

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false), {})).toContain(
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
      expect(getGenCodeScripts(new Project(dirPath, {}, false), {})).not.toContain(
        'YARN gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP'
      );
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('does not run the default gen-i18n-ts command without source code', async () => {
    const dirPath = await createProject({
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
    });
    await fs.mkdir(path.join(dirPath, 'i18n'));

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false), {})).not.toContain(
        'YARN gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP'
      );
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('does not run the project gen-i18n-ts script without source code', async () => {
    const dirPath = await createProject({
      scripts: {
        'gen-i18n-ts': 'gen-i18n-ts -i locales -o src/i18n.ts -d en-US',
      },
    });

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false), {})).not.toContain('YARN run gen-i18n-ts');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('runs prisma generate when the schema exists', async () => {
    const dirPath = await createProject({
      dependencies: {
        prisma: '6.0.0',
      },
    });
    await fs.mkdir(path.join(dirPath, 'prisma'));
    await fs.writeFile(path.join(dirPath, 'prisma', 'schema.prisma'), '');

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false), {})).toContain('PRISMA generate');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('does not run prisma generate without a schema', async () => {
    const dirPath = await createProject({
      dependencies: {
        prisma: '6.0.0',
      },
    });

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false), {})).not.toContain('PRISMA generate');
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

/**
 * The package's committed gitignore rule is the signal that it consumes the generated file.
 */
async function createWorkerProject(packageJson: Record<string, unknown>, ignoresWorkerTypes: boolean): Promise<string> {
  const dirPath = await createProject(packageJson);
  await fs.writeFile(path.join(dirPath, 'wrangler.jsonc'), '{}');
  if (ignoresWorkerTypes) {
    // The exact rule wbfy generates; an anchored path is what marks the package as managed.
    await fs.writeFile(path.join(dirPath, '.gitignore'), '/worker-configuration.d.ts\n');
  }
  return dirPath;
}
