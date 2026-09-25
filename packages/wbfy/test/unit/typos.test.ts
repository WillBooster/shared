import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { fixTypos, fixTyposInCode, fixTyposInText } from '../../src/fixers/typos.js';
import { fsUtil } from '../../src/utils/fsUtil.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { createConfig } from '../helpers/testConfig.js';

test('fixTyposInText normalizes abbreviation typos without touching regular words', () => {
  expect(fixTyposInText('eg. one, ie. two, c.f. three')).toBe('e.g. one, i.e. two, cf. three');
  expect(fixTyposInText('the cookie. crumbles')).toBe('the cookie. crumbles');
  expect(fixTyposInText('my leg. hurts')).toBe('my leg. hurts');
});

test('line-comment typo fixes keep words merely ending in the abbreviation letters intact', () => {
  // Regression: "// ... cookie." used to become "// ... cooki.e." because the pattern
  // lacked a word boundary (observed in agent-challenges src/db/schema.ts).
  expect(fixTyposInCode('// stores the session cookie.\n')).toBe('// stores the session cookie.\n');
  expect(fixTyposInCode('// the left leg. moves\n')).toBe('// the left leg. moves\n');
  expect(fixTyposInCode('// values, eg. one\n')).toBe('// values, e.g. one\n');
  expect(fixTyposInCode('// values, ie. one\n')).toBe('// values, i.e. one\n');
  expect(fixTyposInCode('/* block e.g. one */')).toBe('/* block e.g. one */');
});

test('fixTypos resolves only after every file is rewritten, including files queued in the pool', async () => {
  const dirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-typos-')));
  const oldConcurrency = promisePool.concurrency;
  // With one slot, every file but the first waits in the pool's queue when fixTypos starts them.
  promisePool.concurrency = 1;
  try {
    fsUtil.setRootDirPath(dirPath);
    const fileNames = Array.from({ length: 5 }, (_, i) => `doc${i}.md`);
    for (const fileName of fileNames) {
      fs.writeFileSync(path.join(dirPath, fileName), 'eg. one\n');
    }
    await fixTypos(createConfig({ dirPath, isRoot: true }));
    for (const fileName of fileNames) {
      expect(fs.readFileSync(path.join(dirPath, fileName), 'utf8')).toBe('e.g. one\n');
    }
  } finally {
    promisePool.concurrency = oldConcurrency;
    fsUtil.setRootDirPath(undefined);
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
});
