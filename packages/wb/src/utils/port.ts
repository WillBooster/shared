import type { Project } from '../project.js';

import { killPortProcessImmediatelyAndOnExit } from './process.js';

export async function checkAndKillPortProcess(rawPort: unknown, project: Project): Promise<number> {
  const port = Number(rawPort);
  if (!port) throw new Error(`The given port (${port}) is invalid.`);

  await killPortProcessImmediatelyAndOnExit(port, project);
  return port;
}
