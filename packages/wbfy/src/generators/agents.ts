import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { getPackageManagerCommand } from '../utils/packageCapabilities.js';
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

function generateCursorGeneralMdcContent(
  config: PackageConfig,
  allConfigs: PackageConfig[],
  extraContent?: string
): string {
  const frontmatter = `---\ndescription: General Coding Rules\nglobs:\nalwaysApply: true\n---`;
  const body = generateAgentInstruction(config, allConfigs, 'Cursor', extraContent);
  return `${frontmatter}\n\n${body}`;
}

function generateAgentInstruction(
  rootConfig: PackageConfig,
  allConfigs: PackageConfig[],
  toolName: string,
  extraContent?: string
): string {
  const packageManager = getPackageManagerCommand(rootConfig);
  const description = rootConfig.packageJson?.description;
  // WillBooster Railway project identifiers are managed in deploy workflow settings.
  const railwayInstruction = rootConfig.isRailway
    ? '\n- Railway project information is in the deploy workflows under `.github/workflows`.'
    : '';
  const playwrightTestServerInstruction = hasPlaywrightTestServer(allConfigs)
    ? `\n- Use \`${packageManager} wb start --mode test\` to launch a web server for debugging or testing.`
    : '';
  const coAuthorInstruction = rootConfig.isWillBoosterRepo
    ? `\n  - End your commit message with a blank line followed by \`Co-authored-by: WillBooster (${toolName}) <agent@willbooster.com>\`.`
    : '';
  const baseContent = `
## Project Information

- Name: \`${rootConfig.packageJson?.name || 'unknown'}\`${description ? `\n- Description: ${description}` : ''}
- Package Manager: ${packageManager}

## General Instructions

- If on \`main\`, create a new branch; otherwise work on the current branch.
- Run \`git\` commands one at a time to avoid \`index.lock\` conflicts.
- Write tests when explicitly requested, or when you judge the change worth testing; without a request, cover only the essential behavior.
- When writing tests, follow these rules:
  - Continue modifying tests and/or code until all tests pass.
  - Ensure tests are idempotent and independent (e.g., reset persistent data) so they can run repeatedly or in parallel.
  - Prefer actual API calls over mocks, unless actual calls are impractical, have unintended side effects, or mocks are explicitly requested.
  - Avoid fixed waits in E2E tests; wait for conditions instead.
- When fixing issues (including test failures), investigate the root cause first (e.g., via debug logs or screenshots) and fix it instead of applying workarounds.
- After making changes, run \`${packageManager} verify\` (type checking and linting; takes up to 10 minutes), or \`${packageManager} verify-full\` (all tests; takes up to 1 hour) if you changed runtime behavior or tests (not only types, docs, or config). Fix errors and re-run until it passes.
- Once verified, commit and push to the current (non-main) branch, and create a PR via \`gh\` if none exists for the branch.
  - Follow the Conventional Commits format (e.g., \`feat:\`, \`fix:\`).${coAuthorInstruction}
  - Always create new commits; avoid \`--amend\`.
- Use heredoc for multi-line command input (e.g., \`git commit -F -\`, \`gh pr create --body-file -\`).
- Put temporary files in \`.tmp\`; use \`/tmp\` only for files that must live outside the repo.${railwayInstruction}${playwrightTestServerInstruction}

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

- Use camelCase file names for JavaScript/TypeScript (PascalCase for React components).
- Simplify code as much as possible to eliminate redundancy.
- Design modules and directories with high cohesion and low coupling; split large modules when needed.
- Place calling functions above the functions they call (top-down order); place variable and type declarations above their usage.
- Write comments and JSDoc only for hard-to-understand code: explain "why" in comments and "what" in JSDoc.
- If lint errors or warnings cannot be fixed, use ignore comments with reasons (e.g., \`// oxlint-disable-next-line <rule> -- <reason>\`).
- Prefer \`undefined\` over \`null\` unless required by APIs or libraries.
- Build prompts as a single template literal instead of \`join()\` on a pre-computable array of strings.
- Assume all environment variables are defined; if validation is needed, \`assert\` at startup to fail fast.
${
  allConfigs.some((c) => c.depending.genI18nTs)
    ? `- When adding string literals in React components, register them in the \`i18n\` resource files (e.g., \`i18n/ja-JP.json\`) and reference them via the \`i18n\` utility (e.g., \`i18n.pages.home.title()\` for \`{ "pages": { "home": { "title": "My App" } } }\`).`
    : ''
}

${
  allConfigs.some((c) => c.depending.react || c.depending.next)
    ? `- Prefer lambda over \`function\` for React components, e.g., \`const Button: React.FC = () => {\`.
- Prefer \`useImmer\` over \`useState\` for arrays and objects.
- Use \`autoFocus\` where it reduces user effort.`
    : ''
}
${
  allConfigs.some((c) => c.depending.next)
    ? `
- This project uses the React Compiler, so \`useCallback\` and \`useMemo\` are unnecessary for performance.
- Assume a single server instance.
`
    : ''
}
`
    .replaceAll(/\.\n\n+-/g, '.\n-')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

function hasPlaywrightTestServer(configs: PackageConfig[]): boolean {
  return configs.some((config) => config.depending.playwrightTest);
}
