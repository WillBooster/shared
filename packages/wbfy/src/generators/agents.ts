import fs from 'node:fs';
import path from 'node:path';

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
    ? `\n- Environment variables and secrets are managed in \`fnox.toml\` via mise + fnox; run commands through \`${packageManager} wb ...\` or \`fnox run -P <profile> -- <command>\` instead of expecting \`.env\` files. Never create a \`.env\`, \`.env.*\`, or \`.dev.vars\` file: add the variable to \`fnox.toml\` instead. Profile secrets load only when a profile is selected: mode-aware wb commands (e.g. \`wb start\`, \`wb test\`) and \`wb dotenv\` select it themselves (\`wb dotenv\` uses \`WB_ENV\`, else \`FNOX_PROFILE\`, else \`NODE_ENV\`, else the development profile; \`WB_ENV\` accepts only \`development\`/\`test\`/\`staging\`/\`production\`, so use \`FNOX_PROFILE\` for any other profile), while bare \`fnox run\` needs an explicit \`-P <profile>\`.`
    : '';
  // mise owns the toolchain versions, so a version mismatch is fixed by editing mise.toml — not by
  // installing a different bun/node globally, which the next `mise install` silently overrides.
  const miseInstruction = fs.existsSync(path.resolve(rootConfig.dirPath, 'mise.toml'))
    ? '\n- Tool versions (node, bun, and others) are pinned in `mise.toml`; run `mise install` after changing it, and never install those tools globally instead.'
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
    ? `\n- This project runs on Cloudflare Workers: the wrangler configuration file holds the Worker's configuration, including any bindings and per-environment overrides.${hasDeployWorkflow ? ' The deploy workflows under `.github/workflows` perform deployments.' : ''}${usesWbDeploy ? ' The `deploy` package script runs `wb deploy`.' : ''}${ownsGeneratedWorkerTypes ? `\n- \`worker-configuration.d.ts\` is generated by \`${packageManager} wb gen-code\` and is gitignored; after changing bindings or vars in the wrangler configuration, re-run it instead of editing that file by hand.` : ''}`
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
  - Test externally observable behavior (e.g., emitted files, CLI output, rendered results) at the system boundary, not implementation details: do not mirror production logic, assert that a branch is taken, or feed hand-assembled internal objects to internal functions.
  - Prefer actual API calls over mocks, unless actual calls are impractical, have unintended side effects, or mocks are explicitly requested.
  - Ensure tests are idempotent and independent (e.g., reset persistent data) so they can run repeatedly or in parallel.
  - Avoid fixed waits in E2E tests; wait for conditions instead.
  - Continue modifying tests and/or code until all tests pass.
- When fixing issues (including test failures), investigate the root cause first (e.g., via debug logs or screenshots) and fix it instead of applying workarounds.
- After making changes, run \`${packageManager} run verify\` (type checking and linting; takes up to 10 minutes), or \`${packageManager} run verify-full\` (all tests; takes up to 1 hour) if you changed runtime behavior or tests. Fix errors and re-run until it passes.
  - Agent shells may terminate tracked commands (including background ones) at time limits, often minutes, so run commands that can exceed your shell-call timeout (e.g., \`${packageManager} run verify\` and \`${packageManager} run verify-full\`) detached via nohup, from a shell call that returns immediately: \`mkdir -p .tmp; rm -f .tmp/verify-full.exit; nohup sh -c '${packageManager} run verify-full; echo $? > .tmp/verify-full.exit' > .tmp/verify-full.log 2>&1 &\` (the redirects are required: an inherited stdout/stderr pipe would keep the call waiting). Poll from separate calls, each shorter than your shell-call timeout: \`for i in 1 2 3; do test -f .tmp/verify-full.exit && break; sleep 20; done; cat .tmp/verify-full.exit 2>/dev/null || echo still running\`. Repeat until the exit file appears (its content is the exit code), then read the log; if it never appears while the log stops growing, the run itself died.
- Once verified, commit and push to the current (non-main) branch, and create a PR via \`gh\` if none exists for the branch.
  - Follow the Conventional Commits format (e.g., \`feat:\`, \`fix:\`).${coAuthorInstruction}
  - Always create new commits; avoid \`--amend\`.
- Use heredoc for multi-line command input (e.g., \`git commit -F -\`, \`gh pr create --body-file -\`).
- Put temporary files in \`.tmp\`; use \`/tmp\` only for files that must live outside the repo.${miseInstruction}${isolatedInstallInstruction}${fnoxInstruction}${cloudflareInstruction}${railwayInstruction}${playwrightTestServerInstruction}

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
  // Tauri desktop apps ship Windows builds, so the macOS/Linux-only rule must not ban the
  // Windows-specific code they require.
  const hasDesktopApp = allConfigs.some((c) => c.depending.tauri || c.doesContainTauriConfigInPackages);
  // A public repository with no `@willbooster/` package is OSS for the general public, whose users
  // may run Windows, so no OS restriction applies there. An unknown visibility collapses to
  // isPublicRepo=false and therefore keeps the restrictive default.
  const isGeneralPublicOss =
    rootConfig.isPublicRepo && allConfigs.every((c) => !c.packageJson?.name?.startsWith('@willbooster/'));
  const osCompatibilityInstruction = isGeneralPublicOss
    ? ''
    : hasDesktopApp
      ? '- Server and CLI code targets macOS and Linux; the Tauri desktop app additionally supports Windows, so keep its Windows-specific code working.'
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
    '- Cloudflare Workers run across multiple ephemeral isolates and two requests may hit different instances: never let correctness depend on module-level mutable state; persist authoritative shared state in bindings (D1, KV, R2, Durable Objects). Best-effort isolate-local caches of non-request-scoped data are fine.';
  const serverInstanceInstruction = hasWorkersApp
    ? hasSingleInstanceServerApp
      ? `${workersInstruction} This applies to all code that runs on Cloudflare Workers (the wrangler-configured packages and any workspace package they import); assume a single server instance for the other server apps.`
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
