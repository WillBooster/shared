import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { findWbDeploySegment, hasCloudflareDeployWorkflow } from './workflow.js';

export async function generateAgentInstructions(rootConfig: PackageConfig, allConfigs: PackageConfig[]): Promise<void> {
  return logger.functionIgnoringException('generateAgentInstructions', async () => {
    if (!rootConfig.isRoot) return;

    // Check if AGENTS_EXTRA.md exists and read its content
    const agentsExtraPath = path.resolve(rootConfig.dirPath, 'AGENTS_EXTRA.md');
    const extraContent = await fsUtil.readFileIfExists(agentsExtraPath);

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
  const packageManager = 'bun';
  const description = rootConfig.packageJson?.description;
  const fnoxInstruction = fs.existsSync(path.resolve(rootConfig.dirPath, 'fnox.toml'))
    ? `\n- Environment variables and secrets are managed in \`fnox.toml\` via mise + fnox; run commands through \`${packageManager} wb ...\` or \`fnox run -P <profile> -- <command>\` instead of expecting \`.env\` files. Profile secrets load only when a profile is selected: mode-aware wb commands (e.g. \`wb start\`, \`wb test\`) select it themselves, while \`wb dotenv\` and bare \`fnox run\` need an explicit \`WB_ENV=<profile>\` / \`-P <profile>\`.`
    : '';
  // Every clause states only a verified fact, reusing the workflow generator's own detectors: the
  // wrangler-config clause needs an actual config file (isCloudflare also matches a mere wrangler
  // mention in a script or workflow), the workflow clause needs a live reusable-deploy caller
  // (YAML-parsed jobs.*.uses, not a raw-text/comment match), and the `wb deploy` clause needs a
  // deploy script whose command token is `wb … deploy`.
  const ownsWranglerConfig = allConfigs.some((config) => config.doesContainWranglerConfig);
  const hasDeployWorkflow = hasCloudflareDeployWorkflow(path.resolve(rootConfig.dirPath, '.github/workflows'));
  const usesWbDeploy = allConfigs.some((config) => {
    const deployScript = config.packageJson?.scripts?.['deploy'];
    return typeof deployScript === 'string' && findWbDeploySegment(deployScript) !== undefined;
  });
  // Independent facts stay separate sentences: the workflow's own deploy mechanism is not
  // inspected, so the wb-deploy clause must not claim the workflow invokes it.
  const cloudflareInstruction = ownsWranglerConfig
    ? `\n- This project runs on Cloudflare Workers: the wrangler configuration file holds the Worker's configuration, including any bindings and per-environment overrides.${hasDeployWorkflow ? ' The deploy workflows under `.github/workflows` perform deployments.' : ''}${usesWbDeploy ? ' The `deploy` package script runs `wb deploy`.' : ''}`
    : '';
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
- Write a test only when explicitly requested, or when a behavior is both likely to regress AND has no other automatic safeguard (type checking, linting, or an existing test/CI check would not catch the breakage). Skip the test when an existing signal already catches the regression, or when you are only confirming an external fact (a library's behavior, whether a version fixes an issue)—verify those once manually instead of adding a permanent test.
- When writing tests, follow these rules:
  - Continue modifying tests and/or code until all tests pass.
  - Ensure tests are idempotent and independent (e.g., reset persistent data) so they can run repeatedly or in parallel.
  - Prefer actual API calls over mocks, unless actual calls are impractical, have unintended side effects, or mocks are explicitly requested.
  - Avoid fixed waits in E2E tests; wait for conditions instead.
- When fixing issues (including test failures), investigate the root cause first (e.g., via debug logs or screenshots) and fix it instead of applying workarounds.
- After making changes, run \`${packageManager} verify\` (type checking and linting; takes up to 10 minutes), or \`${packageManager} verify-full\` (all tests; takes up to 1 hour) if you changed runtime behavior or tests. Fix errors and re-run until it passes.
- Once verified, commit and push to the current (non-main) branch, and create a PR via \`gh\` if none exists for the branch.
  - Follow the Conventional Commits format (e.g., \`feat:\`, \`fix:\`).${coAuthorInstruction}
  - Always create new commits; avoid \`--amend\`.
- Use heredoc for multi-line command input (e.g., \`git commit -F -\`, \`gh pr create --body-file -\`).
- Put temporary files in \`.tmp\`; use \`/tmp\` only for files that must live outside the repo.${fnoxInstruction}${cloudflareInstruction}${railwayInstruction}${playwrightTestServerInstruction}

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
  // Tauri desktop apps ship Windows builds, so the macOS/Linux-only rule must not ban the
  // Windows-specific code they require.
  const hasDesktopApp = allConfigs.some((c) => c.depending.tauri || c.doesContainTauriConfigInPackages);
  const osCompatibilityInstruction = hasDesktopApp
    ? '- Server and CLI code targets macOS and Linux; the Tauri desktop app additionally supports Windows, so keep its Windows-specific code working.'
    : '- Ensure compatibility only with macOS and Linux; do not include Windows-specific code.';
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
- Assume local tools such as \`git\`, \`gh\`, and \`ghq\` are installed and authenticated.
${osCompatibilityInstruction}
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
