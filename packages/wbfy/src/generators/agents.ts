import fs from 'node:fs';
import path from 'node:path';

import { PULL_REQUEST_REQUIREMENTS_RULES } from '@willbooster/shared-lib/src';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { generatesWorkerTypes } from '../packageConfig.js';
import { hasCloudflareDeployWorkflow, invokesWbDeploy } from './workflow.js';

export async function generateAgentInstructions(rootConfig: PackageConfig, allConfigs: PackageConfig[]): Promise<void> {
  return logger.functionIgnoringException('generateAgentInstructions', async () => {
    if (!rootConfig.isRoot) return;

    const extraContent = await readAgentsExtraContent(rootConfig.dirPath);

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

const agentsExtraContentCache = new Map<string, string | undefined>();

/**
 * Reads the root's user-authored AGENTS_EXTRA.md once per process: wbfy never rewrites the file,
 * and both the agent-instruction and Gemini generators need its content. Caching the resolved
 * value (not the Promise) is race-free because the two callers run sequentially in index.ts.
 */
export async function readAgentsExtraContent(rootDirPath: string): Promise<string | undefined> {
  const agentsExtraPath = path.resolve(rootDirPath, 'AGENTS_EXTRA.md');
  if (!agentsExtraContentCache.has(agentsExtraPath)) {
    agentsExtraContentCache.set(agentsExtraPath, await fsUtil.readFileIfExists(agentsExtraPath));
  }
  return agentsExtraContentCache.get(agentsExtraPath);
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
    ? `\n- Environment variables and secrets live in \`fnox.toml\` (mise + fnox); never create \`.env\`, \`.env.*\`, or \`.dev.vars\` files. Run commands through \`${packageManager} wb ...\` or \`fnox run -P <profile> -- <command>\`. Profile secrets load only when a profile is selected: mode-aware wb commands (e.g. \`wb start\`, \`wb test\`) and \`wb dotenv\` select it themselves (\`wb dotenv\` uses \`WB_ENV\`, else \`FNOX_PROFILE\`, else \`NODE_ENV\`, else the development profile; \`WB_ENV\` accepts only \`development\`/\`test\`/\`staging\`/\`production\`, so use \`FNOX_PROFILE\` for any other profile), while bare \`fnox run\` needs an explicit \`-P <profile>\`.`
    : '';
  // mise owns the pinned tool versions, so a version mismatch is fixed by editing mise.toml — not
  // by installing a different version globally, which the next `mise install` silently overrides.
  const miseInstruction = fs.existsSync(path.resolve(rootConfig.dirPath, 'mise.toml'))
    ? '\n- Tool versions (e.g., node) are pinned in `mise.toml`; run `mise install` after changing it and never install those tools globally instead.'
    : '';
  // Isolated installs are the org standard (wbfy generates no other linker) and the most
  // agent-hostile part of the stack: a package that is only reachable because a dependency hoisted
  // it no longer resolves, and the reflex fix (switching the linker back) silently reintroduces
  // the phantom dependencies the layout exists to catch.
  const isolatedInstallInstruction = `\n- \`bunfig.toml\` uses Bun's isolated linker, so only declared dependencies resolve. If an import fails to resolve, declare that package in the \`package.json\` that imports it; never switch \`linker\` to \`hoisted\` or add to \`publicHoistPattern\` to work around it.`;
  // Every clause states only a verified fact, reusing the workflow generator's own detectors: the
  // wrangler-config clause needs an actual config file (isCloudflare also matches a mere wrangler
  // mention in a script or workflow), the workflow clause needs a live reusable-deploy caller
  // (YAML-parsed jobs.*.uses, not a raw-text/comment match), and the `wb deploy` clause needs a
  // deploy script whose command token is `wb … deploy`.
  const ownsWranglerConfig = allConfigs.some((config) => config.doesContainWranglerConfig);
  // Only claim the file is generated where it actually is: a package that hand-maintains its `Env` (e.g. under
  // `types: ["bun"]`) is deliberately left unmanaged, and telling an agent to run `wb gen-code` there would send
  // it after a file that never appears — and away from the `Env` it should be editing.
  const ownsGeneratedWorkerTypes = allConfigs.some((config) => generatesWorkerTypes(config));
  const hasDeployWorkflow = hasCloudflareDeployWorkflow(path.resolve(rootConfig.dirPath, '.github/workflows'));
  const usesWbDeploy = allConfigs.some((config) => {
    const deployScript = config.packageJson?.scripts?.['deploy'];
    return (
      typeof deployScript === 'string' &&
      invokesWbDeploy(deployScript, new Set(Object.keys(config.packageJson?.scripts ?? {})))
    );
  });
  // Independent facts stay separate sentences: the workflow's own deploy mechanism is not
  // inspected, so the wb-deploy clause must not claim the workflow invokes it.
  const cloudflareInstruction = ownsWranglerConfig
    ? `\n- This project runs on Cloudflare Workers: the wrangler configuration file holds the Worker's configuration, including bindings and per-environment overrides.${hasDeployWorkflow ? ' The deploy workflows under `.github/workflows` perform deployments.' : ''}${usesWbDeploy ? ' The `deploy` package script runs `wb deploy`.' : ''}${ownsGeneratedWorkerTypes ? `\n- \`worker-configuration.d.ts\` is gitignored and generated by \`${packageManager} wb gen-code\`; after changing bindings or vars in the wrangler configuration, re-run it instead of editing the file by hand.` : ''}`
    : '';
  // WillBooster Railway project identifiers are managed in deploy workflow settings.
  const railwayInstruction = rootConfig.isRailway
    ? '\n- Railway project information is in the deploy workflows under `.github/workflows`.'
    : '';
  const playwrightTestServerInstruction = hasPlaywrightTestServer(allConfigs)
    ? `\n- Use \`${packageManager} wb start --mode test\` to launch a web server for debugging or testing.`
    : '';
  const coAuthorInstruction = rootConfig.isWillBoosterRepo
    ? `\n  - End your commit message with a blank line followed by \`Co-authored-by: WillBooster (${toolName}) <agent@willbooster.com>\`, the only AI attribution to add.`
    : '';
  // Keyed on the repository classification rather than on the template files' presence: the same
  // run writes the templates for WillBooster / WillBoosterLab repositories before this generator
  // runs, and hand-added templates elsewhere belong to AGENTS_EXTRA.md.
  const prTemplateInstruction = rootConfig.isWillBoosterRepo
    ? `\n  - Base the PR body on \`.github/pull_request_template.md\` when creating or updating a PR, even when a skill or workflow supplies its own skeleton: keep the template's headings in order, fill each section with what its placeholder comment asks for at a length fitting the change (a sentence for a small change, numbered subsections for a large one), delete the placeholder comments and an empty Notes section, and keep \`Close #<n>\` only when the PR resolves an existing issue.\n  - Fill the Requirements section by these rules:\n${PULL_REQUEST_REQUIREMENTS_RULES.replaceAll(/^/gm, '    ')}`
    : '';
  // Gated like prTemplateInstruction: the section it names exists only where the template is generated.
  const requirementsExemption = rootConfig.isWillBoosterRepo
    ? ", and so is the PR body's Requirements section, which records what was asked for rather than what the code contains"
    : '';
  const issueTemplateInstruction = rootConfig.isWillBoosterRepo
    ? '\n- When creating an issue, follow the closest template under `.github/ISSUE_TEMPLATE/`: `bug.md` for wrong behavior, `change.md` for anything to build or alter; a question or note fitting neither needs no template. The YAML front matter between the `---` lines is metadata, not body text: prefix the title as its `title` says, pass its `labels` via `--label`, and submit only the content below the closing `---` as the body. Always keep the first three sections of `change.md` and add the rest as the change grows; keep Problem and Proposal of `bug.md` and drop Evidence or Impact when they add nothing. Delete the placeholder comments.'
    : '';
  const projectName = rootConfig.packageJson?.name || path.basename(path.resolve(rootConfig.dirPath));
  const baseContent = `
## Project Information

- Name: \`${projectName}\`${description ? `\n- Description: ${description}` : ''}
- Package Manager: ${packageManager}

## General Instructions

- If on \`main\`, create a new branch; otherwise work on the current branch.
- Run \`git\` commands one at a time to avoid \`index.lock\` conflicts.
- Write a test only when explicitly requested, or when a behavior is likely to regress and no existing automatic check (type checking, linting, an existing test or CI check) would catch the breakage. Never add a test that merely restates a mapping from conditions to constant outputs (it fails only on intentional edits) or that only confirms an external fact (a library's behavior, whether a version fixes an issue); verify those once manually.
- When writing tests, follow these rules:
  - Test externally observable behavior (e.g., emitted files, CLI output, rendered results) at the system boundary, not implementation details: do not mirror production logic, assert that a branch is taken, or feed hand-assembled internal objects to internal functions.
  - Prefer actual API calls over mocks, unless actual calls are impractical, have unintended side effects, or mocks are explicitly requested.
  - Ensure tests are idempotent and independent (e.g., reset persistent data) so they can run repeatedly or in parallel.
  - Avoid fixed waits in E2E tests; wait for conditions instead.
- When fixing issues (including test failures), investigate the root cause first (e.g., via debug logs or screenshots) and fix it instead of applying workarounds.
- After making changes, run \`${packageManager} run verify\` (type checking and linting; up to 10 minutes), or \`${packageManager} run verify-full\` (all tests; up to 1 hour) if you changed runtime behavior or tests. Fix errors and re-run until it passes.
  - Wait for it to finish without restarting it: prefer completion notifications, otherwise the longest permitted wait; no output does not mean it has stopped. If the displayed excerpt is insufficient, read the indicated log file before rerunning. If the environment kills long-running commands, run it detached with a saved log and exit status.
- Once verified, commit and push to the current (non-main) branch, and create a PR via \`gh\` if none exists for the branch.
  - Follow the Conventional Commits format (e.g., \`feat:\`, \`fix:\`).${coAuthorInstruction}
  - Always create new commits; avoid \`--amend\`.${prTemplateInstruction}${issueTemplateInstruction}
- In any explanatory text (commit messages, PR descriptions, documentation, code comments, etc.), describe only the current implementation: drop any statement naming an identifier, feature, or concept you cannot confirm exists in the final diff or the current codebase (e.g., one added and later removed or renamed along the way). Whenever documentation or comments no longer match the current implementation (removed options, deprecated usage, outdated behavior), delete or rewrite them, even in files you are not otherwise changing. Mention a past state only where it is needed to understand why the current design is as it is, or when explicitly asked; files that record history by design (e.g., a changelog) are exempt${requirementsExemption}.
- Use heredoc for multi-line command input (e.g., \`git commit -F -\`, \`gh pr create --body-file -\`, \`gh issue create --body-file -\`).
- Put temporary files in \`.tmp\`; use \`/tmp\` only for files that must live outside the repo.
- \`AGENTS.md\`, \`CLAUDE.md\`, \`GEMINI.md\`, \`.cursor/rules/general.mdc\`, and \`.gemini/styleguide.md\` are generated from \`AGENTS_EXTRA.md\` and overwritten on every \`wbfy\` run; to change agent instructions, edit only \`AGENTS_EXTRA.md\`.${miseInstruction}${isolatedInstallInstruction}${fnoxInstruction}${cloudflareInstruction}${railwayInstruction}${playwrightTestServerInstruction}

${generateAgentCodingStyle(rootConfig, allConfigs)}
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

export function generateAgentCodingStyle(rootConfig: PackageConfig, allConfigs: PackageConfig[]): string {
  // Tauri desktop apps ship Windows builds, and the boundary between app code and shared code is
  // too fuzzy to scope the macOS/Linux-only rule per package, so such repositories target all
  // three OSes instead.
  const hasDesktopApp = allConfigs.some((c) => c.depending.tauri || c.doesContainTauriConfigInPackages);
  // A public repository with no `@willbooster/` package is OSS for the general public, whose users
  // may run Windows, so no OS restriction applies there. An unknown visibility collapses to
  // isPublicRepo=false and therefore keeps the restrictive default.
  const isGeneralPublicOss =
    rootConfig.isPublicRepo && allConfigs.every((c) => !c.packageJson?.name?.startsWith('@willbooster/'));
  const osCompatibilityInstruction = isGeneralPublicOss
    ? ''
    : hasDesktopApp
      ? '- Ensure compatibility with Windows, macOS, and Linux.'
      : '- Ensure compatibility only with macOS and Linux; do not include Windows-specific code.';
  // Cloudflare Workers execute across many ephemeral isolates and two requests are not guaranteed
  // to hit the same instance, so the single-instance simplification silently loses state there —
  // but Workers deliberately reuse execution contexts, so best-effort isolate-local caches stay
  // legitimate (https://developers.cloudflare.com/workers/reference/how-workers-works/). The
  // signals are correlated PER PACKAGE: a monorepo can host a single-instance server app next to
  // an unrelated Worker, and neither may override the other's rule. doesContainWranglerConfig is
  // the accurate Workers signal (isCloudflare also matches a mere wrangler mention in a script or
  // workflow).
  const hasWorkersApp = allConfigs.some((c) => c.doesContainWranglerConfig);
  const hasSingleInstanceServerApp = allConfigs.some(
    (c) => (c.depending.next || c.depending.vinext) && !c.doesContainWranglerConfig
  );
  const workersInstruction =
    '- Cloudflare Workers run across many ephemeral isolates, so two requests may hit different instances: never let correctness depend on module-level mutable state; persist authoritative shared state in bindings (D1, KV, R2, Durable Objects). Best-effort isolate-local caches of non-request-scoped data are fine.';
  const serverInstanceInstruction = hasWorkersApp
    ? hasSingleInstanceServerApp
      ? `${workersInstruction} This applies to all code running on Cloudflare Workers (the wrangler-configured packages and any workspace package they import); assume a single server instance for the other server apps.`
      : workersInstruction
    : hasSingleInstanceServerApp
      ? '- Assume a single server instance.'
      : '';
  // Keep top-down ordering guidance function-only because classes are not hoisted and can fail when inheritance or top-level instantiation depends on declaration order.
  return `
## Coding Style

- Use camelCase file names for JavaScript/TypeScript (PascalCase for React components).
- Simplify code as much as possible to eliminate redundancy.
- Design modules and directories with high cohesion and low coupling; split large modules when needed.
- Place calling functions above the functions they call (top-down order); place variable and type declarations above their usage.
- Write comments and JSDoc only for hard-to-understand code: explain "why" in comments and "what" in JSDoc.
- Never explain how WillBooster's in-house tools (e.g., \`wb\`, \`wbfy\`) work in code comments or documents outside the tool's own package, except in instructions for AI agents (e.g., do not note that \`PORT\` is unset because \`wb\` picks a free port).
- If lint errors or warnings cannot be fixed, use ignore comments with reasons (e.g., \`// oxlint-disable-next-line <rule> -- <reason>\`).
- Prefer \`undefined\` over \`null\` unless required by APIs or libraries.
- Validate JavaScript objects (e.g., parsed JSON, API responses) with \`zod\` whenever possible instead of hand-written checks or type assertions.
- Build prompts as a single template literal instead of \`join()\` on a pre-computable array of strings.
- Assume all environment variables are defined; if validation is needed, \`assert\` them at startup to fail fast.
- Assume local tools such as \`git\`, \`gh\`, and \`ghq\` are installed and authenticated.
${osCompatibilityInstruction}
${
  allConfigs.some((c) => c.depending.genI18nTs)
    ? `- Register string literals for React components in the \`i18n\` resource files (e.g., \`i18n/ja-JP.json\`) and reference them via the \`i18n\` utility (e.g., \`i18n.pages.home.title()\` for \`{ "pages": { "home": { "title": "My App" } } }\`).`
    : ''
}

${
  allConfigs.some((c) => c.depending.react || c.depending.next || c.depending.vinext)
    ? `- Prefer lambda over \`function\` for React components, e.g., \`const Button: React.FC = () => {\`.
- Prefer \`useImmer\` over \`useState\` for arrays and objects.
- Use \`autoFocus\` where it reduces user effort.`
    : ''
}
${
  // vinext is the org's current web-app framework and enables the React Compiler just as Next.js
  // does, so it must not miss this rule.
  allConfigs.some((c) => c.depending.next || c.depending.vinext)
    ? `
- This project uses the React Compiler, so \`useCallback\` and \`useMemo\` are unnecessary for performance.
`
    : ''
}
${serverInstanceInstruction}
`
    .replaceAll(/\.\n\n+-/g, '.\n-')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

function hasPlaywrightTestServer(configs: PackageConfig[]): boolean {
  return configs.some((config) => config.depending.playwrightTest);
}
