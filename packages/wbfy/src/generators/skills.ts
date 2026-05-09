import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';

export async function installAgentSkills(_rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('installAgentSkills', async () => {
    // TODO: We are temporarily not installing managed agent skills into repos.
    // await runInstallAgentSkills(_rootConfig);
  });
}
