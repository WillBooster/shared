import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse } from 'jsonc-parser';
import { expect, test } from 'vitest';

import { generateRenovateJsonc } from '../src/generators/renovateJsonc.js';
import { fsUtil } from '../src/utils/fsUtil.js';
import { promisePool } from '../src/utils/promisePool.js';
import { createConfig } from './testConfig.js';

async function withRepo(files: Record<string, string>, run: (dirPath: string) => Promise<void>): Promise<void> {
  const tempDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-renovate-')));
  try {
    for (const [fileName, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tempDirPath, fileName)), { recursive: true });
      fs.writeFileSync(path.join(tempDirPath, fileName), content);
    }
    fsUtil.setRootDirPath(tempDirPath);
    await generateRenovateJsonc(createConfig({ dirPath: tempDirPath, isRoot: true }));
    await promisePool.promiseAll();
    await run(tempDirPath);
  } finally {
    fsUtil.setRootDirPath(undefined);
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
}

const preset = 'github>WillBooster/willbooster-configs:renovate.json5';

test('generates renovate.jsonc in a repository without any Renovate config', async () => {
  await withRepo({}, async (dirPath) => {
    const content = fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8');
    expect(parseSettings(content).extends).toEqual([preset]);
  });
});

test('migrates renovate.json and deletes it so it stops outranking renovate.jsonc', async () => {
  await withRepo(
    { 'renovate.json': JSON.stringify({ extends: [preset], labels: ['dependencies'] }) },
    async (dirPath) => {
      const content = fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8');
      expect(parseSettings(content).labels).toEqual(['dependencies']);
      expect(fs.existsSync(path.join(dirPath, 'renovate.json'))).toBe(false);
    }
  );
});

test('migrates renovate.json5, whose unquoted keys and single quotes plain JSONC cannot parse', async () => {
  await withRepo(
    {
      'renovate.json5': `{
  $schema: 'https://docs.renovatebot.com/renovate-schema.json',
  extends: ['${preset}'],
  // Scope mapping only (no credentials).
  npmrc: '@willbooster-private:registry=https://example.test/',
}
`,
    },
    async (dirPath) => {
      const settings = parseSettings(fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8'));
      expect(settings.npmrc).toBe('@willbooster-private:registry=https://example.test/');
      expect(settings.extends).toEqual([preset]);
      expect(fs.existsSync(path.join(dirPath, 'renovate.json5'))).toBe(false);
    }
  );
});

test('keeps comments in renovate.jsonc while adding a generated property', async () => {
  await withRepo(
    {
      'renovate.jsonc': `{
  // Keep the private registry mapping close to the preset it complements.
  "npmrc": "@willbooster-private:registry=https://example.test/"
}
`,
    },
    async (dirPath) => {
      const content = fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8');
      expect(content).toContain('// Keep the private registry mapping close to the preset it complements.');
      expect(parseSettings(content).extends).toEqual([preset]);
    }
  );
});

test('lets the config Renovate actually reads win over a dead lower-priority one', async () => {
  // renovate.json outranks renovate.json5, so its value is the live setting to carry over.
  await withRepo(
    {
      'renovate.json': JSON.stringify({ timezone: 'Asia/Tokyo' }),
      'renovate.json5': "{ timezone: 'UTC' }",
    },
    async (dirPath) => {
      const settings = parseSettings(fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8'));
      expect(settings.timezone).toBe('Asia/Tokyo');
      expect(fs.existsSync(path.join(dirPath, 'renovate.json5'))).toBe(false);
    }
  );
});

test('keeps a pre-existing renovate.jsonc winning over a superseded config ranked below it', async () => {
  // renovate.jsonc outranks renovate.json5, so the value Renovate actually reads must survive.
  await withRepo(
    {
      'renovate.jsonc': JSON.stringify({ timezone: 'Asia/Tokyo' }),
      'renovate.json5': "{ timezone: 'UTC' }",
    },
    async (dirPath) => {
      const settings = parseSettings(fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8'));
      expect(settings.timezone).toBe('Asia/Tokyo');
      expect(fs.existsSync(path.join(dirPath, 'renovate.json5'))).toBe(false);
    }
  );
});

test('lets renovate.json override a pre-existing renovate.jsonc, since it outranks it', async () => {
  await withRepo(
    {
      'renovate.jsonc': JSON.stringify({ timezone: 'Asia/Tokyo' }),
      'renovate.json': JSON.stringify({ timezone: 'UTC' }),
    },
    async (dirPath) => {
      const settings = parseSettings(fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8'));
      expect(settings.timezone).toBe('UTC');
      expect(fs.existsSync(path.join(dirPath, 'renovate.json'))).toBe(false);
    }
  );
});

test('deletes an empty superseded config, which would otherwise keep outranking renovate.jsonc', async () => {
  await withRepo({ 'renovate.json': '' }, async (dirPath) => {
    expect(fs.existsSync(path.join(dirPath, 'renovate.json'))).toBe(false);
    expect(fs.existsSync(path.join(dirPath, 'renovate.jsonc'))).toBe(true);
  });
});

test('keeps a comment nested inside extends while adding the generated preset', async () => {
  await withRepo(
    {
      'renovate.jsonc': `{
  "extends": [
    // Keep the local preset last so it overrides the organization defaults.
    "local>team/config"
  ]
}
`,
    },
    async (dirPath) => {
      const content = fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8');
      expect(content).toContain('// Keep the local preset last so it overrides the organization defaults.');
      expect(parseSettings(content).extends).toEqual([preset, 'local>team/config']);
    }
  );
});

test('leaves a renovate.jsonc declaring the same property twice untouched', async () => {
  // parseObjectIgnoringError keeps the last occurrence while modify() rewrites the first, so
  // editing such a file would write to the occurrence that does not take effect.
  const duplicateContent = '{ "extends": ["a"], "extends": ["b"] }';
  await withRepo({ 'renovate.jsonc': duplicateContent }, async (dirPath) => {
    expect(fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8')).toBe(duplicateContent);
  });
});

test('bails when a shadowed config outranks the superseded one, leaving the live config alone', async () => {
  // .github/renovate.json (4) outranks .renovaterc.json (11), so migrating the latter would
  // abandon the config Renovate actually reads.
  await withRepo(
    {
      '.github/renovate.json': JSON.stringify({ timezone: 'Asia/Tokyo' }),
      '.renovaterc.json': JSON.stringify({ timezone: 'UTC' }),
    },
    async (dirPath) => {
      expect(fs.existsSync(path.join(dirPath, 'renovate.jsonc'))).toBe(false);
      expect(fs.existsSync(path.join(dirPath, '.renovaterc.json'))).toBe(true);
    }
  );
});

test('does not resurrect settings that only a dead lower-priority config declares', async () => {
  await withRepo(
    {
      'renovate.jsonc': JSON.stringify({ timezone: 'Asia/Tokyo' }),
      'renovate.json5': '{ automerge: true }',
    },
    async (dirPath) => {
      const settings = parseSettings(fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8'));
      expect(settings.automerge).toBeUndefined();
      expect(settings.timezone).toBe('Asia/Tokyo');
      expect(fs.existsSync(path.join(dirPath, 'renovate.json5'))).toBe(false);
    }
  );
});

test('keeps comments while migrating a renovate.json, whose syntax is editable in place', async () => {
  await withRepo(
    {
      'renovate.json': `{
  // Tokyo business hours keep the noise out of the night.
  "timezone": "Asia/Tokyo"
}
`,
    },
    async (dirPath) => {
      const content = fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8');
      expect(content).toContain('// Tokyo business hours keep the noise out of the night.');
      expect(parseSettings(content).timezone).toBe('Asia/Tokyo');
      expect(fs.existsSync(path.join(dirPath, 'renovate.json'))).toBe(false);
    }
  );
});

test('keeps a trailing comment attached to the property it describes', async () => {
  await withRepo(
    { 'renovate.jsonc': '{\n  "timezone": "UTC" // Renovate must use Tokyo business hours.\n}\n' },
    async (dirPath) => {
      const content = fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8');
      expect(content).toMatch(/"timezone": "UTC",? \/\/ Renovate must use Tokyo business hours\./u);
    }
  );
});

test("matches the file's existing indentation instead of reindenting it", async () => {
  await withRepo({ 'renovate.jsonc': '{\n    "timezone": "UTC"\n}\n' }, async (dirPath) => {
    const content = fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8');
    expect(content).toMatch(/^ {4}"\$schema":/mu);
    expect(content).toMatch(/^ {8}"github>WillBooster/mu);
  });
});

test('keeps a BOM-prefixed comment-only file parsable after generation', async () => {
  // modify() inserts the generated object before leading trivia, which would strand the BOM
  // mid-file where it is a syntax error rather than an ignored mark.
  await withRepo({ 'renovate.jsonc': '\uFEFF// preserve me\n' }, async (dirPath) => {
    const content = fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8');
    expect(content).toContain('// preserve me');
    expect(content).not.toContain('\uFEFF');
    expect(parseSettings(content).extends).toEqual([preset]);
  });
});

test('migrates a valid live config even when a dead lower-priority one is malformed', async () => {
  await withRepo(
    {
      'renovate.json': JSON.stringify({ timezone: 'Asia/Tokyo' }),
      'renovate.jsonc': '{ "extends": [ }',
    },
    async (dirPath) => {
      const settings = parseSettings(fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8'));
      expect(settings.timezone).toBe('Asia/Tokyo');
      expect(fs.existsSync(path.join(dirPath, 'renovate.json'))).toBe(false);
    }
  );
});

test('bails instead of shadowing a config Renovate resolves after renovate.jsonc', async () => {
  await withRepo({ '.github/renovate.json': JSON.stringify({ extends: [preset] }) }, async (dirPath) => {
    expect(fs.existsSync(path.join(dirPath, 'renovate.jsonc'))).toBe(false);
  });
});

test('leaves an unparsable renovate.jsonc untouched', async () => {
  const brokenContent = '{ "extends": [ }';
  await withRepo({ 'renovate.jsonc': brokenContent }, async (dirPath) => {
    expect(fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8')).toBe(brokenContent);
  });
});

function parseSettings(content: string): Record<string, unknown> {
  return parse(content, [], { allowTrailingComma: true }) as Record<string, unknown>;
}
