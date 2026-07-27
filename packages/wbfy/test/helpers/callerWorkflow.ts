import fs from 'node:fs';
import path from 'node:path';

import { load } from 'js-yaml';
import { expect } from 'vitest';

export interface CallerJob {
  secrets?: Record<string, string>;
}

/** Runs the callback in a fresh temp repository containing a .github/workflows directory. */
export async function withTempWorkflowsRepo(
  prefix: string,
  callback: (dirPath: string, workflowsPath: string) => Promise<void>
): Promise<void> {
  const tempRootPath = path.join(process.cwd(), '.tmp');
  await fs.promises.mkdir(tempRootPath, { recursive: true });
  const dirPath = await fs.promises.mkdtemp(path.join(tempRootPath, prefix));
  try {
    const workflowsPath = path.join(dirPath, '.github', 'workflows');
    await fs.promises.mkdir(workflowsPath, { recursive: true });
    await callback(dirPath, workflowsPath);
  } finally {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  }
}

/** Reads the sole job of a generated caller workflow. */
export function readCallerJob(workflowsPath: string, fileName = 'test.yml'): CallerJob {
  const parsed = load(fs.readFileSync(path.join(workflowsPath, fileName), 'utf8')) as {
    jobs: Record<string, CallerJob>;
  };
  const job = Object.values(parsed.jobs)[0];
  expect(job).toBeDefined();
  // The non-null assertion is checked by the expect above.
  return job as CallerJob;
}
