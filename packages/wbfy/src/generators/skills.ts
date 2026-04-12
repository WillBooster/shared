import fs from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';

// const targetAgents = ['claude-code', 'codex', 'cursor', 'gemini-cli'];
// const installTargetAgentArgs = targetAgents.flatMap((agent) => ['--agent', agent]);
// const skillsRepo = 'WillBooster/agent-skills';
// const playwrightSkillName = 'playwright-cli';
// const nonWebRemovalAgentArgs = ['--agent', 'universal', ...installTargetAgentArgs];

export async function installAgentSkills(rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('installAgentSkills', async () => {
    // TODO: We are temporarily removing agent skills from the repo
    // await runInstallAgentSkills(rootConfig);
    await Promise.all([
      fs.rm(path.resolve(rootConfig.dirPath, '.agents'), {
        force: true,
        recursive: true,
      }),
      fs.rm(path.resolve(rootConfig.dirPath, '.claude'), {
        force: true,
        recursive: true,
      }),
      fs.rm(path.resolve(rootConfig.dirPath, 'skills-lock.json'), {
        force: true,
      }),
    ]);
  });
}

// function isWebAppRelated(config: PackageConfig): boolean {
//   return (
//     config.depending.next ||
//     config.depending.playwrightTest ||
//     config.depending.react ||
//     config.depending.storybook ||
//     config.doesContainJsxOrTsx ||
//     config.doesContainJsxOrTsxInPackages
//   );
// }
//
// async function runInstallAgentSkills(rootConfig: PackageConfig): Promise<void> {
//   if (!rootConfig.isRoot) return;
//
//   const commonArgs = ['--yes', 'skills@latest', 'add', skillsRepo, ...installTargetAgentArgs, '--skill', '*', '--yes'];
//   spawnSync('npx', commonArgs, rootConfig.dirPath);
//
//   if (isWebAppRelated(rootConfig)) return;
//
//   spawnSync(
//     'npx',
//     ['skills@latest', 'remove', playwrightSkillName, ...nonWebRemovalAgentArgs, '--yes'],
//     rootConfig.dirPath
//   );
//   await Promise.all([
//     // The Vercel CLI leaves the shared universal install behind in this flow,
//     // so non-web repos need an explicit cleanup pass to enforce the final state.
//     removeSkillDirectory(rootConfig.dirPath, '.agents/skills'),
//     removeSkillDirectory(rootConfig.dirPath, '.claude/skills'),
//     removeSkillDirectory(rootConfig.dirPath, '.codex/skills'),
//     removeSkillDirectory(rootConfig.dirPath, '.cursor/skills'),
//     removeSkillDirectory(rootConfig.dirPath, '.gemini/skills'),
//     removeSkillDirectory(rootConfig.dirPath, '.gemini/commands'),
//     removeSkillLockEntry(rootConfig.dirPath),
//   ]);
// }
//
// async function removeSkillDirectory(rootDirPath: string, relativeParentDirPath: string): Promise<void> {
//   await fs.rm(path.resolve(rootDirPath, relativeParentDirPath, playwrightSkillName), {
//     force: true,
//     recursive: true,
//   });
// }
//
// async function removeSkillLockEntry(rootDirPath: string): Promise<void> {
//   const filePath = path.resolve(rootDirPath, 'skills-lock.json');
//   try {
//     const jsonText = await fs.readFile(filePath, 'utf8');
//     const json: unknown = JSON.parse(jsonText);
//     if (!isSkillLockJson(json) || !json.skills[playwrightSkillName]) return;
//     json.skills = Object.fromEntries(Object.entries(json.skills).filter(([name]) => name !== playwrightSkillName));
//     await fs.writeFile(filePath, JSON.stringify(json, undefined, 2) + '\n');
//   } catch {
//     // Ignore if the skill lock does not exist yet or is unreadable.
//   }
// }
//
// function isSkillLockJson(json: unknown): json is { skills: Record<string, unknown> } {
//   return (
//     typeof json === 'object' &&
//     json !== null &&
//     'skills' in json &&
//     typeof json.skills === 'object' &&
//     json.skills !== null &&
//     !Array.isArray(json.skills)
//   );
// }
