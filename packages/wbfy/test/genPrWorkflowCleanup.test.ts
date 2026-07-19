import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { isObsoleteGenPrWorkflow } from '../src/generators/workflow.js';

let workflowsPath: string;

beforeEach(async () => {
  workflowsPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wbfy-gen-pr-'));
});

afterEach(async () => {
  await fs.promises.rm(workflowsPath, { recursive: true, force: true });
});

function writeWorkflow(fileName: string, content: string): void {
  fs.writeFileSync(path.join(workflowsPath, fileName), content);
}

test.each(['gen-pr.yml', 'gen-pr.yaml', 'gen-pr-claude.yml'])('detects %s by filename', (fileName) => {
  expect(isObsoleteGenPrWorkflow(workflowsPath, fileName)).toBe(true);
});

test('detects a caller of the reusable gen-pr workflow under another filename', () => {
  writeWorkflow(
    'ai.yml',
    `on: issues
jobs:
  gen-pr:
    uses: WillBooster/reusable-workflows/.github/workflows/gen-pr.yml@main
    secrets: inherit
`
  );
  expect(isObsoleteGenPrWorkflow(workflowsPath, 'ai.yml')).toBe(true);
});

test('keeps a mixed workflow whose other jobs do not call gen-pr', () => {
  writeWorkflow(
    'mixed.yml',
    `on: issues
jobs:
  gen-pr:
    uses: WillBooster/reusable-workflows/.github/workflows/gen-pr.yml@main
  test:
    uses: WillBooster/reusable-workflows/.github/workflows/test.yml@main
`
  );
  expect(isObsoleteGenPrWorkflow(workflowsPath, 'mixed.yml')).toBe(false);
});

test('keeps unrelated and unparsable workflows', () => {
  writeWorkflow(
    'test.yml',
    `on: push
jobs:
  test:
    uses: WillBooster/reusable-workflows/.github/workflows/test.yml@main
`
  );
  // The reusable path appears only in a comment of an unparsable file; a text match must not delete it.
  writeWorkflow('broken.yml', '# WillBooster/reusable-workflows/.github/workflows/gen-pr.yml@main\njobs: [invalid\n');
  expect(isObsoleteGenPrWorkflow(workflowsPath, 'test.yml')).toBe(false);
  expect(isObsoleteGenPrWorkflow(workflowsPath, 'broken.yml')).toBe(false);
  expect(isObsoleteGenPrWorkflow(workflowsPath, 'missing.yml')).toBe(false);
});
