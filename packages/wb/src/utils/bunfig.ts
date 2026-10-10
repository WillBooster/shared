import fs from 'node:fs';
import path from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

const bunfigSchema = z.object({
  test: z.object({ timeout: z.int().positive().optional() }).optional(),
});

/**
 * The per-test default timeout in milliseconds that the project declares as `[test] timeout`.
 * Bun 1.4.3 does not read that key itself (https://github.com/oven-sh/bun/issues/7789), and a preload's
 * `setDefaultTimeout` reaches only one file of a run without per-file isolation, such as the e2e run
 * (https://github.com/oven-sh/bun/issues/43787), so only `bun test --timeout` covers every file.
 * Only the project's own bunfig.toml counts: `bun test` loads none from an ancestor directory.
 */
export function readBunTestTimeout(projectDirPath: string): number | undefined {
  const bunfigPath = path.join(projectDirPath, 'bunfig.toml');
  if (!fs.existsSync(bunfigPath)) return undefined;
  return bunfigSchema.parse(parseToml(fs.readFileSync(bunfigPath, 'utf8'))).test?.timeout;
}
