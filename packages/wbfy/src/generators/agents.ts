import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

export async function generateAgentInstructions(rootConfig: PackageConfig, allConfigs: PackageConfig[]): Promise<void> {
  return logger.functionIgnoringException('generateAgentInstructions', async () => {
    if (!rootConfig.isRoot) return;

    // Check if AGENTS_EXTRA.md exists and read its content
    const agentsExtraPath = path.resolve(rootConfig.dirPath, 'AGENTS_EXTRA.md');
    const extraContent = await fsUtil.readFileIgnoringError(agentsExtraPath);

    for (const [fileName, toolName] of [
      ['AGENTS.md', 'Codex CLI'],
      ['CLAUDE.md', 'Claude Code'],
      ['GEMINI.md', 'Gemini CLI'],
    ] as const) {
      const content = generateAgentInstruction(rootConfig, allConfigs, toolName, extraContent);
      const filePath = path.resolve(rootConfig.dirPath, fileName);
      await promisePool.run(() => fsUtil.generateFile(filePath, content));
    }

    const cursorRulesPath = path.resolve(rootConfig.dirPath, '.cursor/rules/general.mdc');
    const cursorRulesContent = generateCursorGeneralMdcContent(rootConfig, allConfigs, extraContent);
    await promisePool.run(() => fsUtil.generateFile(cursorRulesPath, cursorRulesContent));
  });
}

function generateAgentInstruction(
  rootConfig: PackageConfig,
  allConfigs: PackageConfig[],
  toolName: string,
  extraContent?: string
): string {
  const packageManager = rootConfig.isBun ? 'bun' : 'yarn';
  const baseContent = `
## Project Information

- Name: \`${rootConfig.packageJson?.name || 'unknown'}\`
- Description: ${rootConfig.packageJson?.description}
- Package Manager: ${packageManager}

## General Instructions

- Create a new branch if the current branch is \`main\`.
- Run any \`git\` commands sequentially.
- Write tests ONLY if explicitly requested. If requested, follow these rules:
  - Continue modifying the tests and code until all tests pass.
  - Ensure tests reset any related persistent data, as our test infrastructure does not clear it automatically.
  - Prefer actual API calls over mocks. Use mocks when actual calls are impractical, have unintended side effects, or are explicitly requested.
- Before fixing issues, always investigate the root cause first (e.g., by gathering debug logs, taking screenshots, etc.).
- After making code changes, run \`${packageManager} check-all-for-ai\` to execute all tests (takes up to 1 hour) or \`${packageManager} check-for-ai\` for type checking and linting only (takes up to 10 minutes).
  - If you are confident your changes will not break any tests, you may use \`check-for-ai\`.
- Once you have verified your changes, commit and push them to the current (non-main) branch then create a PR via \`gh\`.
  - Follow the conventional commits; your commit message should start with \`feat:\`, \`fix:\`, etc.
  - If not specified, make sure to add a new line at the end of your commit message${rootConfig.isWillBoosterRepo ? ` with: \`Co-authored-by: WillBooster (${toolName}) <agent@willbooster.com>\`` : ''}.
  - Always create new commits. Avoid using \`--amend\`.
${
  allConfigs.some((c) => c.hasStartTestServer)
    ? `- Use \`${packageManager} run start-test-server\` to launch a web server for debugging or testing.`
    : ''
}

${generateAgentCodingStyle(allConfigs)}
`
    .replaceAll(/\.\n\n+-/g, '.\n-')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();

  const hasNewSection = extraContent?.trim().startsWith('#');
  const normalizedExtraContent = extraContent
    ? hasNewSection
      ? '\n\n' + extraContent.trim()
      : '\n' + extraContent
    : '';
  return baseContent + normalizedExtraContent;
}

export function generateAgentCodingStyle(allConfigs: PackageConfig[]): string {
  // Keep top-down ordering guidance function-only because classes are not hoisted and can fail when inheritance or top-level instantiation depends on declaration order.
  return `
## Coding Style

- Use camelCase for JavaScript and TypeScript files (or PascalCase for React components).
- Simplify code as much as possible to eliminate redundancy.
- Design each module with high cohesion, grouping related functionality together.
  - Refactor existing large modules into smaller, focused modules when necessary.
  - Create well-organized directory structures with low coupling and high cohesion.
- Place calling functions in the file above the functions they call to maintain a clear top-down order.
  - e.g. \`function caller() { callee(); } function callee() { ... }\`
- Write comments that explain "why" rather than "what". Avoid stating what can be understood from the code itself.
- Prefer \`undefined\` over \`null\` unless explicitly required by APIs or libraries.
- Prefer using a single template literal for prompts instead of \`join()\` with an array of strings.
${
  allConfigs.some((c) => c.depending.genI18nTs)
    ? `- When introducing new string literals in React components, update the language resource files in the \`i18n\` directory (e.g., \`i18n/ja-JP.json\`). Reference these strings using the \`i18n\` utility. For example, use \`i18n.pages.home.title()\` for \`{ "pages": { "home": { "title": "My App" } } }\`.`
    : ''
}
${
  allConfigs.some((c) => c.depending.react || c.depending.next)
    ? `- Prefer \`useImmer\` for storing an array or an object to \`useState\`.`
    : ''
}
${
  allConfigs.some((c) => c.depending.next)
    ? `
- Since this project uses the React Compiler, you do not need to use \`useCallback\` or \`useMemo\` for performance optimization.
- Assume there is only a single server instance.
`
    : ''
}
`
    .replaceAll(/\.\n\n+-/g, '.\n-')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

function generateCursorGeneralMdcContent(
  config: PackageConfig,
  allConfigs: PackageConfig[],
  extraContent?: string
): string {
  const frontmatter = `---\ndescription: General Coding Rules\nglobs:\nalwaysApply: true\n---`;
  const body = generateAgentInstruction(config, allConfigs, 'Cursor', extraContent);
  return `${frontmatter}\n\n${body}`;
}
