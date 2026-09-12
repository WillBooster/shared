import fs from 'node:fs/promises';
import path from 'node:path';

import * as yaml from 'js-yaml';
import { z } from 'zod';

import type { PackageConfig } from '../packageConfig.js';

const runnerSchema = z.union([z.string(), z.array(z.string())]);
const workflowSchema = z.object({
  jobs: z.record(
    z.string(),
    z
      .object({
        'runs-on': runnerSchema.optional(),
        strategy: z.object({ matrix: z.record(z.string(), z.unknown()) }).optional(),
      })
      .nullable()
  ),
});

export async function assertPrivateWorkflowRunners(config: PackageConfig, workflowsPath: string): Promise<void> {
  if (config.isPublicRepo || !config.isRepoVisibilityKnown) return;
  const entries = await fs.readdir(workflowsPath, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const { name: fileName } of entries.filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))) {
    const workflow = workflowSchema.parse(yaml.load(await fs.readFile(path.join(workflowsPath, fileName), 'utf8')));
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (!job?.['runs-on']) continue;
      const runner = job['runs-on'];
      if (isSelfHosted(runner)) continue;
      const match = typeof runner === 'string' && /^\$\{\{\s*matrix\.(\w+)\s*\}\}$/u.exec(runner);
      const candidates: unknown[] = [];
      if (match && job.strategy) {
        const key = match[1]!;
        const matrix = job.strategy.matrix;
        const values = z.array(z.unknown()).safeParse(matrix[key]);
        if (values.success) candidates.push(...values.data);
        const include = z.array(z.record(z.string(), z.unknown())).safeParse(matrix.include);
        if (include.success)
          candidates.push(...include.data.map((row) => row[key]).filter((value) => value !== undefined));
      } else {
        candidates.push(runner);
      }
      const allowed =
        candidates.length > 0 &&
        candidates.every(
          (candidate) =>
            isSelfHosted(candidate) ||
            (config.repository?.toLowerCase() === 'github:willbooster/cheerlings' &&
              fileName === 'build-desktop-apps.yml' &&
              jobName === 'build' &&
              candidate === 'windows-latest')
        );
      if (!allowed) {
        throw new Error(
          `${fileName}: jobs.${jobName}.runs-on must select self-hosted runners in a private repository. Fix the workflow before running wbfy.`
        );
      }
    }
  }
}

function isSelfHosted(runner: unknown): boolean {
  const labels = runnerSchema.safeParse(runner);
  if (!labels.success) return false;
  if (Array.isArray(labels.data)) return labels.data.includes('self-hosted');
  return labels.data === 'self-hosted';
}
